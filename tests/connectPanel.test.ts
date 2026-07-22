import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The panel resolves its config dir through agentDir(), which reads PRIVATEER_HOME
// lazily on every call — so pointing it at a throwaway home keeps these tests off the
// developer's real connectors, and re-pointing it BETWEEN tests is all it takes to
// give each one a private config.
//
// EVERY TEST STARTS FROM A HOME IT DECLARES. Tests used to share one home and inherit
// whatever their predecessors wrote, so a single real failure cascaded into four and
// assertions like "row 0 is github" silently depended on test order. A test that needs
// existing connectors now seeds them explicitly via freshHome({...}).
const HOMES: string[] = [];
let AGENT = "";

const SOURCE = () => join(AGENT, "mcp-desktop.json");
const readProj = () =>
  existsSync(join(AGENT, "mcp.json")) ? JSON.parse(readFileSync(join(AGENT, "mcp.json"), "utf8")) : { mcpServers: {} };
const readSource = () => JSON.parse(readFileSync(SOURCE(), "utf8"));

// Connectors to seed with, matching what the catalog would have written.
const GITHUB = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_livetoken" },
  enabled: true,
};
const MEMORY = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-memory"],
  enabled: true,
};

// Point PRIVATEER_HOME at a brand-new dir, optionally pre-populated. Seeding writes
// BOTH files the way mcpControl does — source of truth plus the enabled-only
// projection — so a test that reads mcp.json without writing first still sees a
// coherent config rather than an empty one.
function freshHome(seed?: Record<string, unknown>): void {
  const home = mkdtempSync(join(tmpdir(), "priv-connect-"));
  HOMES.push(home);
  process.env.PRIVATEER_HOME = home;
  AGENT = join(home, "agent");
  if (!seed) return;
  mkdirSync(AGENT, { recursive: true });
  writeFileSync(SOURCE(), JSON.stringify({ servers: seed }, null, 2) + "\n");
  const mcpServers: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(seed)) {
    const { enabled, ...std } = entry as Record<string, unknown>;
    if (enabled !== false) mcpServers[name] = std;
  }
  writeFileSync(join(AGENT, "mcp.json"), JSON.stringify({ mcpServers }, null, 2) + "\n");
}

const { default: privateerConnect } = await import("../extensions/privateer-connect.ts");

// A fake pi + ctx that render nothing: ui.custom invokes the component factory and
// hands back a promise the panel resolves by calling close(). That is exactly the
// contract privateer-models.ts relies on, so driving it here exercises the real
// keystroke → mcpControl → mcp.json path with no terminal involved.
interface Driver {
  send(...keys: string[]): void;
  done: Promise<any>;
  notices: string[];
  reloads: number;
}

function openPanel(): Driver {
  let handler!: (args: string, ctx: any) => Promise<void>;
  privateerConnect({
    registerCommand: (name: string, opts: any) => {
      assert.equal(name, "connect");
      handler = opts.handler;
    },
  });
  assert.ok(handler, "registerCommand('connect') was never called");

  const notices: string[] = [];
  let reloads = 0;
  let panel: any;
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const tui = { requestRender: () => {} };

  const ctx = {
    ui: {
      notify: (m: string) => notices.push(m),
      custom: (factory: any) =>
        new Promise((resolve) => {
          panel = factory(tui, theme, undefined, (r: any) => resolve(r));
          panel.focused = true;
        }),
    },
    reload: async () => {
      reloads++;
    },
  };

  // A panel that never calls close() would leave `done` pending forever. node:test
  // reacts to that by draining the event loop and cancelling every LATER test too
  // ("cancelledByParent"), which turns one real bug into a wall of unrelated
  // failures — the exact thing that made the paste bug hard to read. Racing a timer
  // keeps a stuck panel contained: it fails its own test, with the reason.
  //
  // Getting stuck is a REAL failure mode, not a hypothetical: a required step whose
  // value never arrives sets "That one's required." and stays on the form, so the
  // trailing ESC only walks back a step instead of closing the panel.
  let timer: ReturnType<typeof setTimeout>;
  const stuck = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("panel never closed — a step probably refused to advance")),
      2000,
    );
  });
  const done = Promise.race([handler("", ctx).then(() => ({ notices, reloads })), stuck]).finally(() =>
    clearTimeout(timer),
  );

  return {
    send: (...keys: string[]) => keys.forEach((k) => panel.handleInput(k)),
    done,
    notices,
    reloads,
  };
}

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
// How a REAL paste reaches the panel: pi-tui's Terminal re-wraps clipboard content in
// bracketed-paste markers and hands it over as one chunk. Tests that send bare text
// instead are testing a wire format the terminal never produces.
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

test("connect: quick-adds a zero-setup connector and reloads the adapter", async () => {
  freshHome();
  const d = openPanel();
  // "a" opens the catalog; type to filter to Memory (needs: none, so no form steps);
  // enter saves it outright. esc then closes the panel.
  d.send("a", "m", "e", "m", "o", ENTER);
  d.send(ESC);
  const res: any = await d.done;

  const proj = readProj().mcpServers.memory;
  assert.ok(proj, `memory not projected — got ${JSON.stringify(readProj())}`);
  assert.equal(proj.command, "npx");
  assert.deepEqual(proj.args, ["-y", "@modelcontextprotocol/server-memory"]);
  // A write must reload, or the new connector only appears on the next launch.
  assert.equal(res.reloads, 1, "ctx.reload() should fire after a change");
  assert.ok(res.notices.length === 1, "exactly one notify on close");
});

test("connect: a token wizard masks the secret and writes it to disk", async () => {
  freshHome();
  const d = openPanel();
  d.send("a", "g", "i", "t", "h", "u", "b", ENTER); // pick GitHub → one secret step
  // The masked field takes a paste chunk whole; arrow keys must NOT leak into it.
  d.send(DOWN, "ghp_livetoken", ENTER);
  d.send(ESC);
  await d.done;

  const proj = readProj().mcpServers.github;
  assert.ok(proj, "github not projected");
  assert.equal(
    proj.env.GITHUB_PERSONAL_ACCESS_TOKEN,
    "ghp_livetoken",
    "arrow-key bytes must not corrupt the token",
  );
});

test("connect: a pasted token lands in the masked field", async () => {
  freshHome();
  const d = openPanel();
  d.send("a", "n", "o", "t", "i", "o", "n", ENTER); // pick Notion → one secret step
  // The whole point: a bracketed-paste chunk starts with ESC, and must not be
  // mistaken for an arrow key and swallowed.
  d.send(paste("ntn_pastedsecret"), ENTER);
  d.send(ESC);
  await d.done;

  const proj = readProj().mcpServers.notion;
  assert.ok(proj, "notion not projected");
  assert.equal(proj.env.NOTION_TOKEN, "ntn_pastedsecret", "pasted token was swallowed");
});

test("connect: a pasted token keeps its trailing newline out of the value", async () => {
  freshHome();
  const d = openPanel();
  d.send("a", "n", "o", "t", "i", "o", "n", ENTER);
  d.send(paste("ntn_trailing\n"), ENTER);
  d.send(ESC);
  await d.done;

  assert.equal(readProj().mcpServers.notion.env.NOTION_TOKEN, "ntn_trailing");
});

test("connect: space toggles enabled, which drops it from the projection", async () => {
  freshHome({ github: GITHUB }); // the only connector, so row 0 is unambiguous
  const d = openPanel();
  d.send(" ");
  d.send(ESC);
  await d.done;

  assert.equal(readProj().mcpServers.github, undefined, "disabled server left the projection");
  // …but it is still MANAGED, so it can be toggled back on.
  const src = readSource();
  assert.equal(src.servers.github.enabled, false);
  assert.equal(src.servers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_livetoken", "toggle kept the credential");
});

test("connect: 'd' arms, and only a second 'd' removes", async () => {
  // Sorted by name: github is row 0, memory row 1 — and memory is the bystander the
  // last assertion checks was left alone. The three panels below deliberately share
  // this home: each step's state is what the previous step wrote.
  freshHome({ github: GITHUB, memory: MEMORY });

  // A single d must NOT delete — the credential is unrecoverable.
  const armed = openPanel();
  armed.send("d");
  armed.send(ESC);
  const res: any = await armed.done;
  assert.equal(res.reloads, 0, "arming is not a change");
  assert.ok(readSource().servers.github, "one press must leave the connector alone");

  // Moving the cursor between the two presses disarms, so the second d re-arms
  // rather than deleting whatever row the cursor landed on.
  const moved = openPanel();
  moved.send("d", DOWN, "d");
  moved.send(ESC);
  await moved.done;
  assert.ok(readSource().servers.github, "a cursor move must disarm the pending removal");

  const d = openPanel();
  d.send("d", "d"); // github (row 0), confirmed
  d.send(ESC);
  await d.done;

  assert.equal(readSource().servers.github, undefined, "removed from the source of truth");
  assert.equal(readProj().mcpServers.github, undefined, "removed from the projection");
  assert.ok(readProj().mcpServers.memory, "the other connector is untouched");
});

test("connect: a custom entry infers transport from what you type", async () => {
  freshHome();
  const d = openPanel();
  // Catalog → last row is "Custom…". Filter to it, then walk the three steps.
  d.send("a", "c", "u", "s", "t", "o", "m", ENTER);
  d.send("mine", ENTER); // name
  d.send("https://mcp.example.com/sse", ENTER); // target → inferred http
  d.send(ENTER); // env is optional
  d.send(ESC);
  await d.done;

  const proj = readProj().mcpServers.mine;
  assert.ok(proj, "custom connector not projected");
  assert.equal(proj.url, "https://mcp.example.com/sse");
  assert.equal(proj.oauth, true);
  assert.equal(proj.command, undefined, "an http entry must not carry a command");
});

test("connect: closing without changes does not reload", async () => {
  freshHome({ github: GITHUB }); // a populated list, so this isn't just an empty no-op
  const d = openPanel();
  d.send(ESC);
  const res: any = await d.done;
  assert.equal(res.reloads, 0);
  assert.equal(res.notices.length, 0, "no notify when nothing changed");
});

process.on("exit", () => {
  for (const home of HOMES) rmSync(home, { recursive: true, force: true });
});
