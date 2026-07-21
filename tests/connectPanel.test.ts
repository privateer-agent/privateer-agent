import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The panel resolves its config dir through agentDir(), which reads PRIVATEER_HOME
// lazily on every call — so pointing it at a throwaway home BEFORE the extension is
// imported keeps these tests off the developer's real connectors.
const HOME = mkdtempSync(join(tmpdir(), "priv-connect-"));
process.env.PRIVATEER_HOME = HOME;

const AGENT = join(HOME, "agent");
const readProj = () =>
  existsSync(join(AGENT, "mcp.json")) ? JSON.parse(readFileSync(join(AGENT, "mcp.json"), "utf8")) : { mcpServers: {} };

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

  const done = handler("", ctx).then(() => ({ notices, reloads }));
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

test("connect: quick-adds a zero-setup connector and reloads the adapter", async () => {
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

test("connect: space toggles enabled, which drops it from the projection", async () => {
  const d = openPanel();
  // The list is sorted by name, so row 0 is github regardless of what was added when.
  d.send(" ");
  d.send(ESC);
  await d.done;

  assert.equal(readProj().mcpServers.github, undefined, "disabled server left the projection");
  // …but it is still MANAGED, so it can be toggled back on.
  const src = JSON.parse(readFileSync(join(AGENT, "mcp-desktop.json"), "utf8"));
  assert.equal(src.servers.github.enabled, false);
  assert.equal(src.servers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_livetoken", "toggle kept the credential");
});

test("connect: 'd' arms, and only a second 'd' removes", async () => {
  // A single d must NOT delete — the credential is unrecoverable.
  const armed = openPanel();
  armed.send("d");
  armed.send(ESC);
  const res: any = await armed.done;
  assert.equal(res.reloads, 0, "arming is not a change");
  assert.ok(
    JSON.parse(readFileSync(join(AGENT, "mcp-desktop.json"), "utf8")).servers.github,
    "one press must leave the connector alone",
  );

  // Moving the cursor between the two presses disarms, so the second d re-arms
  // rather than deleting whatever row the cursor landed on.
  const moved = openPanel();
  moved.send("d", DOWN, "d");
  moved.send(ESC);
  await moved.done;
  assert.ok(
    JSON.parse(readFileSync(join(AGENT, "mcp-desktop.json"), "utf8")).servers.github,
    "a cursor move must disarm the pending removal",
  );

  const d = openPanel();
  d.send("d", "d"); // github (row 0), confirmed
  d.send(ESC);
  await d.done;

  const src = JSON.parse(readFileSync(join(AGENT, "mcp-desktop.json"), "utf8"));
  assert.equal(src.servers.github, undefined, "removed from the source of truth");
  assert.equal(readProj().mcpServers.github, undefined, "removed from the projection");
  assert.ok(readProj().mcpServers.memory, "the other connector is untouched");
});

test("connect: a custom entry infers transport from what you type", async () => {
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
  const d = openPanel();
  d.send(ESC);
  const res: any = await d.done;
  assert.equal(res.reloads, 0);
  assert.equal(res.notices.length, 0, "no notify when nothing changed");
});

process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));
