import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dirname, "..");

// An extension only reaches the user if the launcher knows about it in BOTH places:
// the MANAGED list (which removes the stale shim first) and its own shim() call. Miss
// the shim() and the command never appears; miss MANAGED and a shim from an older
// version lingers pointing at a file that may no longer exist. Nothing else fails when
// you forget — the extension is simply, silently absent — so check it here.
test("launcher: every privateer extension is shimmed and managed", () => {
  const launcher = readFileSync(join(REPO, "bin", "privateer-launch.mjs"), "utf8");
  const files = readdirSync(join(REPO, "extensions"))
    .filter((f) => f.startsWith("privateer-") && f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""));

  assert.ok(files.length > 0, "no extensions found — is the path still right?");
  for (const name of files) {
    assert.ok(
      launcher.includes(`"${name}"`),
      `${name} is missing from the launcher's MANAGED list (a stale shim would linger)`,
    );
    assert.ok(
      launcher.includes(`shim("${name}"`),
      `${name} has no shim() call in the launcher, so it never loads`,
    );
  }
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

// The gate is auto-discovered into EVERY session that shares ~/.privateer/agent —
// including the ones the harbor daemon stands up, where its module-level bridge never
// gets a relay (only /remote-access attaches one, and the daemon has no TUI). Pi resolves
// duplicate tool names first-registration-wins and loads discovered extensions BEFORE
// inline factories, so a gate that still registered send_file_to_client there would
// shadow the session-scoped one a live task spawn binds to its own connected relay — and
// every send would answer "remote access is off" while the app sat attached and driving.
// Pin both halves: tools present in a normal terminal, absent inside the daemon.
async function gateToolNames(daemon: boolean): Promise<string[]> {
  const home = mkdtempSync(join(tmpdir(), "priv-extload-gate-tools-"));
  const agentDir = join(home, "agent");
  const extDir = join(agentDir, "extensions");
  mkdirSync(extDir, { recursive: true });
  const prevHome = process.env.PRIVATEER_HOME;
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  const wasChild = process.env.PI_SUBAGENT_CHILD;
  const wasDaemon = process.env.PRIVATEER_HARBOR_DAEMON;
  process.env.PRIVATEER_HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENT_CHILD = "1"; // skip the parent approval relay's live timer
  if (daemon) process.env.PRIVATEER_HARBOR_DAEMON = "1";
  else delete process.env.PRIVATEER_HARBOR_DAEMON;

  try {
    const target = join(REPO, "extensions", "privateer-gate.ts");
    writeFileSync(
      join(extDir, "privateer-gate.ts"),
      `export { default } from ${JSON.stringify(pathToFileURL(target).href)};\n`,
    );
    const { createAgentSessionServices } = await import("@earendil-works/pi-coding-agent");
    const services = await createAgentSessionServices({ cwd: REPO, agentDir });
    const loaded = services.resourceLoader.getExtensions();
    const mine = loaded.extensions.filter((e: any) => String(e.path).includes("privateer-gate"));
    assert.equal(mine.length, 1, "privateer-gate did not load");
    const tools = (mine[0] as any).tools;
    return tools instanceof Map ? [...tools.keys()] : Object.keys(tools ?? {});
  } finally {
    if (prevHome === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prevHome;
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
    if (wasChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = wasChild;
    if (wasDaemon === undefined) delete process.env.PRIVATEER_HARBOR_DAEMON;
    else process.env.PRIVATEER_HARBOR_DAEMON = wasDaemon;
    rmSync(home, { recursive: true, force: true });
  }
}

test("extensions: privateer-gate owns the relay file tools in a terminal", async () => {
  const names = await gateToolNames(false);
  for (const tool of ["send_file_to_client", "save_attachment"]) {
    assert.ok(names.includes(tool), `expected ${tool}, got: ${names.join(", ") || "(none)"}`);
  }
});

test("extensions: privateer-gate stands its file tools down inside the harbor daemon", async () => {
  const names = await gateToolNames(true);
  for (const tool of ["send_file_to_client", "save_attachment"]) {
    assert.ok(
      !names.includes(tool),
      `${tool} would shadow the live task's own (session-scoped) registration; got: ${names.join(", ")}`,
    );
  }
});
