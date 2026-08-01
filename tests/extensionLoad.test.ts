import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MOAT_SHIMS, managedNames } from "../src/config/moatManifest.ts";

const REPO = resolve(import.meta.dirname, "..");

// An extension only reaches the user if the shipping manifest knows about it: the
// launcher installs a shim for every entry and sweeps every managed name first, so a
// missing entry means the extension is simply, silently absent — and a stale shim from an
// older version lingers pointing at a file that may no longer exist. Since the launcher,
// extensionsControl's RESERVED set, and the profile lists are all derived from that one
// file now, this is the only place the omission can happen.
test("manifest: every privateer extension is listed, and every entry resolves", () => {
  const files = readdirSync(join(REPO, "extensions"))
    .filter((f) => f.startsWith("privateer-") && f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""));
  assert.ok(files.length > 0, "no extensions found — is the path still right?");

  const listed = new Set(MOAT_SHIMS.map((s) => s.name));
  for (const name of files) {
    assert.ok(listed.has(name), `${name} is missing from src/config/moatManifest.json, so it never loads`);
  }
  // Each entry names exactly one target, and a first-party `entry` must actually exist —
  // the launcher silently skips a shim whose target is missing (right for an optional npm
  // pack, wrong for one of ours, where it would mean the extension quietly vanished).
  for (const s of MOAT_SHIMS) {
    assert.ok(
      (s.entry ? 1 : 0) + (s.dep ? 1 : 0) === 1,
      `${s.name}: set exactly one of "entry" (first-party) or "dep" (npm package)`,
    );
    if (s.entry) {
      assert.ok(existsSync(join(REPO, s.entry)), `${s.name}: entry "${s.entry}" does not exist`);
    }
  }
});

// The launcher can't import TS, so it re-derives its list from the same JSON. If it ever
// grows a hand-written copy again the two silently fork: the launcher would load an
// extension under a name RESERVED doesn't cover, or sweep one it no longer ships.
test("manifest: the launcher reads it rather than carrying its own list", () => {
  const launcher = readFileSync(join(REPO, "bin", "privateer-launch.mjs"), "utf8");
  assert.ok(
    launcher.includes("moatManifest.json"),
    "the launcher no longer reads the manifest — its extension list has forked from the TS side",
  );
  assert.ok(managedNames().length > MOAT_SHIMS.length, "retired names are missing from the sweep list");
});

// The moat reaches the TUI as `-e` args and NOTHING of ours goes into the shared agent
// dir. Both halves matter and fail differently: drop the `-e` args and a terminal launches
// with no permission gate; start writing shims again and every other Privateer process
// silently loads a second moat next to the one it built (which is the bug this replaced).
test("launcher: hands the moat to Pi as -e args and writes nothing into the agent dir", () => {
  const launcher = readFileSync(join(REPO, "bin", "privateer-launch.mjs"), "utf8");
  assert.match(launcher, /MOAT_PATHS[\s\S]*?flatMap\(\(p\) => \["-e", p\]\)/, "the moat is no longer passed as -e args");
  assert.match(launcher, /\.\.\.extArgs/, "the -e args are built but never reach the spawn");
  assert.ok(
    !/writeFileSync\(\s*path\.join\(EXT_DIR/.test(launcher),
    "the launcher writes into the agent dir's extensions/ again — that directory is the user's alone now",
  );
  // The sweep has to survive too: a stale shim from <=0.11 is worse than a missing one.
  assert.ok(launcher.includes("sweepLegacyShims"), "the legacy-shim sweep is gone; upgrades would keep loading them");
});

// A subagent child has no discovery to fall back on, so the wrapper's -e injection is the
// only thing standing between it and running ungated. The launcher must route children
// through the wrapper, not straight at Pi's cli.js as it did while shims existed.
test("launcher: routes subagent children through the moat-injecting wrapper", () => {
  const launcher = readFileSync(join(REPO, "bin", "privateer-launch.mjs"), "utf8");
  const assignment = /PI_SUBAGENT_PI_BINARY\s*=\s*([^;\n]+)/.exec(launcher)?.[1] ?? "";
  assert.match(assignment, /privateer-subagent\.mjs/, `children would be spawned ungated: PI_SUBAGENT_PI_BINARY = ${assignment}`);
  assert.ok(
    launcher.includes("PRIVATEER_CHILD_EXTENSIONS"),
    "the TUI no longer hands its moat down to children, so they'd fall back to the headless floor",
  );
});

// Load privateer-connect the way Pi actually does — through the real resource loader
// and the same shim bin/privateer-launch.mjs writes — rather than by importing it with
// tsx like the other tests. Pi resolves extensions through its package manager and
// evaluates each with its OWN jiti instance (moduleCache: false), which is where an
// unresolvable import or a top-level side effect shows up. The unit tests can't see
// that: they import the module directly and would pass regardless.
test("extensions: privateer-connect loads under Pi's real loader and registers /connect", async () => {
  const home = mkdtempSync(join(tmpdir(), "priv-extload-"));
  const agentDir = join(home, "agent");
  const extDir = join(agentDir, "extensions");
  mkdirSync(extDir, { recursive: true });
  // Keep the loaded extension pointed at a throwaway home, not the developer's.
  process.env.PRIVATEER_HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const target = join(REPO, "extensions", "privateer-connect.ts");
    writeFileSync(
      join(extDir, "privateer-connect.ts"),
      `export { default } from ${JSON.stringify(pathToFileURL(target).href)};\n`,
    );

    const { createAgentSessionServices } = await import("@earendil-works/pi-coding-agent");
    const services = await createAgentSessionServices({ cwd: REPO, agentDir });
    const loaded = services.resourceLoader.getExtensions();

    const errors = (loaded.errors ?? []) as Array<{ path?: string; error?: unknown }>;
    assert.equal(errors.length, 0, `extension load errors: ${JSON.stringify(errors)}`);

    const mine = loaded.extensions.filter((e: any) => String(e.path).includes("privateer-connect"));
    assert.equal(mine.length, 1, "privateer-connect did not load");

    // Pi invokes the factory during load, so its registrations are on the record.
    const commands = (mine[0] as any).commands;
    const names = commands instanceof Map ? [...commands.keys()] : Object.keys(commands ?? {});
    assert.ok(names.includes("connect"), `expected /connect, got: ${names.join(", ") || "(none)"}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Same real-loader check for the gate — the extension that owns the moat, and the one
// that reaches furthest outside itself: it pulls in @earendil-works/pi-tui (for the
// shift+tab no-quarter chord) on top of the relay/bridge tree. Any of those failing to
// resolve under Pi's jiti loader would take the whole permission gate down with it, and
// a direct tsx import in the other tests wouldn't notice.
test("extensions: privateer-gate loads under Pi's real loader and registers /no-quarter", async () => {
  const home = mkdtempSync(join(tmpdir(), "priv-extload-gate-"));
  const agentDir = join(home, "agent");
  const extDir = join(agentDir, "extensions");
  mkdirSync(extDir, { recursive: true });
  process.env.PRIVATEER_HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Load as a subagent child. Same module graph and the same registerCommand calls,
  // but the top-level session skips startParentApprovalRelay — whose channel watcher
  // is a live timer that would keep the test runner's event loop open forever.
  const wasChild = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";

  try {
    const target = join(REPO, "extensions", "privateer-gate.ts");
    writeFileSync(
      join(extDir, "privateer-gate.ts"),
      `export { default } from ${JSON.stringify(pathToFileURL(target).href)};\n`,
    );

    const { createAgentSessionServices } = await import("@earendil-works/pi-coding-agent");
    const services = await createAgentSessionServices({ cwd: REPO, agentDir });
    const loaded = services.resourceLoader.getExtensions();

    const errors = (loaded.errors ?? []) as Array<{ path?: string; error?: unknown }>;
    assert.equal(errors.length, 0, `extension load errors: ${JSON.stringify(errors)}`);

    const mine = loaded.extensions.filter((e: any) => String(e.path).includes("privateer-gate"));
    assert.equal(mine.length, 1, "privateer-gate did not load");

    const commands = (mine[0] as any).commands;
    const names = commands instanceof Map ? [...commands.keys()] : Object.keys(commands ?? {});
    for (const cmd of ["mode", "no-quarter", "remote-access"]) {
      assert.ok(names.includes(cmd), `expected /${cmd}, got: ${names.join(", ") || "(none)"}`);
    }
  } finally {
    if (wasChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = wasChild;
    rmSync(home, { recursive: true, force: true });
  }
});

// Load the gate the way it now actually loads: as an explicit `-e` path, which Pi resolves
// into the loader's additionalExtensionPaths. `subagentChild` selects which caller we are
// standing in for — bin/privateer-subagent.mjs (a child) or bin/privateer-launch.mjs (a
// terminal). It also skips the parent approval relay's live timer, which would otherwise
// hold the test runner's event loop open.
async function loadGate(subagentChild: boolean): Promise<{ tools: string[]; toolCallHandlers: number }> {
  const home = mkdtempSync(join(tmpdir(), "priv-extload-gate-tools-"));
  const agentDir = join(home, "agent");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  const prevHome = process.env.PRIVATEER_HOME;
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  const wasChild = process.env.PI_SUBAGENT_CHILD;
  process.env.PRIVATEER_HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENT_CHILD = "1";

  try {
    const { createAgentSessionServices } = await import("@earendil-works/pi-coding-agent");
    const services = await createAgentSessionServices({
      cwd: REPO,
      agentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: [join(REPO, "extensions", "privateer-gate.ts")],
      } as any,
    });
    const loaded = services.resourceLoader.getExtensions();
    const mine = loaded.extensions.filter((e: any) => String(e.path).includes("privateer-gate"));
    assert.equal(mine.length, 1, `privateer-gate did not load via -e (subagentChild=${subagentChild})`);
    const tools = (mine[0] as any).tools;
    const handlers = (mine[0] as any).handlers;
    const forToolCall = handlers instanceof Map ? handlers.get("tool_call") : handlers?.tool_call;
    return {
      tools: tools instanceof Map ? [...tools.keys()] : Object.keys(tools ?? {}),
      toolCallHandlers: forToolCall?.length ?? 0,
    };
  } finally {
    if (prevHome === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prevHome;
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
    if (wasChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = wasChild;
    rmSync(home, { recursive: true, force: true });
  }
}

// ⚠️ THE ONE THAT MATTERS. A subagent child has no discovery and no inline factories: the
// `-e` injection in bin/privateer-subagent.mjs is the ONLY route by which a permission gate
// reaches it. If this stops registering a tool_call handler, every child runs every tool
// ungated — the exact failure the wrapper exists to prevent.
test("extensions: privateer-gate installs its gate when loaded as an explicit -e path", async () => {
  const { toolCallHandlers } = await loadGate(true);
  assert.ok(toolCallHandlers > 0, "a subagent child lost its only permission gate — it would run every tool ungated");
});

// The gate's relay file tools used to stand down inside the harbor daemon, because the
// shared agent dir made this extension discoverable there and Pi resolves duplicate tool
// names first-registration-wins — so its pair would shadow the session-scoped pair a live
// task spawn binds to its own connected relay, and every send answered "remote access is
// off" while the app sat attached and driving. The daemon no longer loads this file at all,
// so the registration is unconditional; pin that it still happens where it belongs.
test("extensions: privateer-gate owns the relay file tools wherever it loads", async () => {
  const { tools } = await loadGate(false);
  for (const tool of ["send_file_to_client", "save_attachment"]) {
    assert.ok(tools.includes(tool), `expected ${tool}, got: ${tools.join(", ") || "(none)"}`);
  }
});
