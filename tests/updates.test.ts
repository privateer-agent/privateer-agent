import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The two kinds of pending update (src/updates.ts) and the surfaces that act on them:
// the banner's ⚑ line (extensions/privateer-brand.ts) and the `privateer update` grammar
// (bin/update-route.mjs).
//
// The routing half is the one with a shipped bug behind it. `privateer update
// --extensions` — the command Pi's own startup box told users to run — hit the launcher's
// self-update branch, which ignored the flag and reinstalled the CLI. Anyone following
// the on-screen instruction got a reinstall and no pack update, twice as slow and
// silently wrong, so each spelling is pinned here.

const home = mkdtempSync(join(tmpdir(), "privateer-updates-"));
process.env.PRIVATEER_HOME = home;
// An empty agent dir and an empty cwd mean "no packs configured", which is what keeps
// the /update tests below offline: with nothing configured there is no registry to ask.
process.env.PI_CODING_AGENT_DIR = join(home, "agent");

const { pendingCliUpdate, pendingPackUpdates, setPendingPackUpdates, onPackUpdatesChanged } =
  await import("../src/updates.ts");
const { routeUpdate } = await import("../bin/update-route.mjs");
const { headerComponent } = await import("../extensions/privateer-brand.ts");
const { default: privateerUpdate } = await import("../extensions/privateer-update.ts");

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const banner = () =>
  headerComponent({ background: "dark" }, "privateer")
    .render(120)
    .map(plain)
    .join("\n");

// Visible width, computed independently of the module under test: strip SGR escapes,
// then count ⚓ as the two cells a terminal gives it (mirrors tests/banner.test.ts).
function cells(s: string): number {
  let w = 0;
  for (const ch of plain(s)) w += ch === "⚓" ? 2 : 1;
  return w;
}

test("update routing: bare `update` still means the CLI", () => {
  assert.equal(routeUpdate([]), "self");
  assert.equal(routeUpdate(["--self"]), "self");
  assert.equal(routeUpdate(["self"]), "self");
  assert.equal(routeUpdate(["pi"]), "self");
});

test("update routing: the pack spellings reach the package manager", () => {
  assert.equal(routeUpdate(["--extensions"]), "packs");
  assert.equal(routeUpdate(["--extension", "pi-hermes-memory"]), "packs");
  assert.equal(routeUpdate(["pi-hermes-memory"]), "packs");
  assert.equal(routeUpdate(["github:owner/repo"]), "packs");
});

test("update routing: --help answers the question instead of reinstalling", () => {
  assert.equal(routeUpdate(["--help"]), "help");
  assert.equal(routeUpdate(["-h"]), "help");
});

test("update routing: --all is packs THEN the CLI, never Pi's own --all", () => {
  assert.equal(routeUpdate(["--all"]), "all");
  // --all wins even alongside a spelling that would otherwise pick one half.
  assert.equal(routeUpdate(["--extensions", "--all"]), "all");
});

test("pendingCliUpdate reads the launcher's cache and only reports NEWER", () => {
  const cache = join(home, "update-check.json");
  assert.equal(pendingCliUpdate("0.12.7"), null); // no cache yet

  writeFileSync(cache, JSON.stringify({ latest: "0.12.8" }));
  assert.equal(pendingCliUpdate("0.12.7"), "0.12.8");
  assert.equal(pendingCliUpdate("0.12.8"), null); // current
  assert.equal(pendingCliUpdate("0.13.0"), null); // ahead of the registry (a dev build)

  writeFileSync(cache, "not json");
  assert.equal(pendingCliUpdate("0.12.7"), null); // malformed is "nothing pending", never a throw
});

test("the pack flag is absent until a check finds something, then names it", () => {
  setPendingPackUpdates([]);
  assert.ok(!banner().includes("/update"), "banner flags packs before any check found one");

  setPendingPackUpdates([
    { source: "pi-hermes-memory", displayName: "pi-hermes-memory", type: "npm", scope: "user" },
  ]);
  const one = banner();
  assert.match(one, /⚑ update ready for pi-hermes-memory/);
  assert.ok(one.includes("/update"), "the flag must say how to act on it");

  // More than one and the line counts instead of listing — the banner stays one line.
  setPendingPackUpdates([
    { source: "pi-hermes-memory", displayName: "pi-hermes-memory", type: "npm", scope: "user" },
    { source: "github:owner/repo", displayName: "owner/repo", type: "git", scope: "project" },
  ]);
  assert.match(banner(), /⚑ 2 tool pack updates ready/);
});

test("the pack row keeps the frame square", () => {
  setPendingPackUpdates([
    { source: "pi-hermes-memory", displayName: "pi-hermes-memory", type: "npm", scope: "user" },
  ]);
  const lines = headerComponent({ background: "dark" }, "privateer").render(120);
  const widths = new Set(lines.map(cells));
  assert.equal(widths.size, 1, `ragged frame: widths ${[...widths].join(", ")}`);
});

// A stand-in for the extension host: collects what the extension registered, so a test
// can invoke /update the way a user would.
function mountUpdateExtension() {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  privateerUpdate({
    on: (event: string, handler: any) => handlers.set(event, handler),
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
  });
  return { handlers, commands };
}

function fakeCtx(overrides: Record<string, any> = {}) {
  const notes: Array<{ msg: string; kind?: string }> = [];
  const statuses: Array<string | undefined> = [];
  let reloaded = 0;
  const ctx = {
    hasUI: true,
    cwd: home, // an empty dir: no project settings, so no packs and no network
    isProjectTrusted: () => false,
    isIdle: () => true,
    reload: async () => {
      reloaded++;
    },
    ui: {
      notify: (msg: string, kind?: string) => notes.push({ msg, kind }),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
    },
    ...overrides,
  };
  return { ctx, notes, statuses, reloads: () => reloaded };
}

test("/update on a terminal with nothing to fetch says so, and does not reload", async () => {
  const { commands } = mountUpdateExtension();
  const update = commands.get("update");
  assert.ok(update, "the extension must register /update");

  const { ctx, notes, reloads } = fakeCtx();
  await update.handler("", ctx);

  assert.equal(reloads(), 0, "nothing to install must not cost the user a reload");
  assert.equal(notes.length, 1);
  assert.match(notes[0].msg, /Tool packs are current/);
});

test("/update check reports the CLI release alongside the packs", async () => {
  writeFileSync(join(home, "update-check.json"), JSON.stringify({ latest: "999.0.0" }));
  const { commands } = mountUpdateExtension();
  const { ctx, notes } = fakeCtx();

  await commands.get("update").handler("check", ctx);

  assert.equal(notes.length, 1);
  // The CLI cannot be swapped under a running process, so the reply must send them to
  // the shell for that half rather than implying /update covers it.
  assert.match(notes[0].msg, /privateer update/);
  assert.match(notes[0].msg, /999\.0\.0/);
});

test("the startup check never runs on a headless surface", async () => {
  const { handlers } = mountUpdateExtension();
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart, "the extension must check on session_start");

  setPendingPackUpdates([]);
  let asked = false;
  const { ctx } = fakeCtx({
    hasUI: false,
    // Building a package manager is the first thing a check does, and it asks for the
    // session's trust decision — so this being called means the check ran.
    isProjectTrusted: () => {
      asked = true;
      return false;
    },
  });
  await sessionStart({ reason: "startup" }, ctx);
  assert.equal(asked, false, "harbor/ACP/print have no banner and nobody to type /update");
});

test("listeners fire on every change, so the banner never shows a stale flag", () => {
  let fired = 0;
  onPackUpdatesChanged(() => fired++);

  setPendingPackUpdates([
    { source: "pi-hermes-memory", displayName: "pi-hermes-memory", type: "npm", scope: "user" },
  ]);
  assert.equal(fired, 1);
  assert.equal(pendingPackUpdates().length, 1);

  // /update clears the list before reloading — the flag must come down with it.
  setPendingPackUpdates([]);
  assert.equal(fired, 2);
  assert.equal(pendingPackUpdates().length, 0);
});
