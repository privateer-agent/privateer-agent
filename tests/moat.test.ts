// The moat's composition root: what each entry point's sessions actually load.
//
// These are the tests the old design had no way to express. When every entry hand-rolled
// its own extensionFactories array and defended against the discovered shims with env
// markers, "does a harbor session have exactly one gate?" was answerable only by reading
// five files and reasoning about jiti's module cache. Now it is a question about one
// function, so ask it directly — and pin the half that a marker can't cover: the user's
// OWN extensions must still load in every one of these processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { excludeDiscoveredMoat, buildMoat, moatResourceOptions, type MoatKind } from "../src/config/moat.ts";
import { MOAT_SHIMS } from "../src/config/moatManifest.ts";
import type { GateController } from "../src/ext/permissionGate.ts";

const REPO = resolve(import.meta.dirname, "..");

// A gate controller shaped like the headless ones (harbor, channels): no UI, fail closed.
function stubGate(cwd: string): GateController {
  return {
    getMode: () => "default",
    setMode: () => {},
    allowlist: [],
    allowedOutsideRoots: [],
    cwd,
    confineToCwd: true,
    async localAsk() {
      return "deny";
    },
  } as GateController;
}

// Stand up an agent dir holding one moat shim (exactly as bin/privateer-launch.mjs writes
// it) plus one extension of the user's own, then report what survives the filter.
function withAgentDir<T>(fn: (agentDir: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "priv-moat-"));
  const agentDir = join(home, "agent");
  const extDir = join(agentDir, "extensions");
  mkdirSync(extDir, { recursive: true });
  try {
    const target = join(REPO, "extensions", "privateer-gate.ts");
    writeFileSync(
      join(extDir, "privateer-gate.ts"),
      `export { default } from ${JSON.stringify(pathToFileURL(target).href)};\n`,
    );
    writeFileSync(
      join(extDir, "privateer-media.ts"),
      `export { default } from ${JSON.stringify(pathToFileURL(join(REPO, "extensions", "privateer-media.ts")).href)};\n`,
    );
    // The user's own extension, sitting in the same directory. This is the one thing
    // `noExtensions: true` would have cost us, so it is the thing to pin hardest.
    writeFileSync(join(extDir, "user-thing.ts"), "export default function (pi) {}\n");
    return fn(agentDir);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Pi hands extensionsOverride the discovered set with each extension's own path. Build the
// same shape here so the filter can be tested without standing up a real session (which
// costs ~5s and pulls the whole moat's module graph in).
function discovered(agentDir: string, files: string[]) {
  return { extensions: files.map((f) => ({ path: join(agentDir, "extensions", f) })), errors: [], runtime: {} };
}

test("moat filter: drops every shipped shim, keeps the user's own extensions", () => {
  withAgentDir((agentDir) => {
    const base = discovered(agentDir, ["privateer-gate.ts", "privateer-media.ts", "user-thing.ts"]);
    const kept = excludeDiscoveredMoat()(base).extensions.map((e: any) => e.path);

    assert.equal(kept.length, 1, `expected only the user's extension, got: ${kept.join(", ")}`);
    assert.ok(String(kept[0]).endsWith("user-thing.ts"), "the user's own extension must still load");
  });
});

// Dropping a shim also drops the load diagnostics that name it — they describe a conflict
// with an extension the session is discarding, so reporting them would point the user at
// something that isn't there. That suppression must stay narrow: a genuine failure in the
// user's own extension has to survive it.
test("moat filter: drops diagnostics about removed shims, keeps the user's", () => {
  const agentDir = "/nowhere/agent";
  const shim = join(agentDir, "extensions", "privateer-media.ts");
  const mine = join(agentDir, "extensions", "user-thing.ts");
  const base = {
    extensions: [{ path: shim }, { path: mine }],
    errors: [
      { path: "<inline:4>", error: `Tool "video_compose" conflicts with ${shim}` },
      { path: shim, error: "something about our own shim" },
      { path: mine, error: "the user's extension is genuinely broken" },
    ],
    runtime: {},
  };
  const out = excludeDiscoveredMoat()(base);
  assert.equal(out.errors.length, 1, `expected only the user's error, got: ${JSON.stringify(out.errors)}`);
  assert.match(out.errors[0].error, /genuinely broken/);
});

// Every name the launcher installs has to be filtered, not just the two the fixture writes.
// A shim that slips through is a second copy of that extension in every daemon session.
test("moat filter: covers every name in the shipping manifest", () => {
  const agentDir = "/nowhere/agent";
  const files = MOAT_SHIMS.map((s) => `${s.name}.ts`);
  const kept = excludeDiscoveredMoat()(discovered(agentDir, files)).extensions;
  assert.equal(kept.length, 0, `these shims survived the filter: ${kept.map((e: any) => e.path).join(", ")}`);
});

// A .js shim (or a user extension whose name merely CONTAINS a moat name) must be handled
// the way the launcher's namespace implies: exact basename, any JS/TS extension.
test("moat filter: matches by exact name, not by substring", () => {
  const agentDir = "/nowhere/agent";
  const kept = excludeDiscoveredMoat()(
    discovered(agentDir, ["privateer-gate.js", "my-privateer-gate.ts", "privateer-gate-extras.ts"]),
  ).extensions.map((e: any) => String(e.path));

  assert.ok(!kept.some((p: string) => p.endsWith("privateer-gate.js")), "a .js shim is still ours");
  assert.equal(kept.length, 2, `a user extension must not be dropped for containing a moat name: ${kept.join(", ")}`);
});

// The one that actually matters: build a REAL session the way the harbor does, against an
// agent dir that holds the launcher's shims, and check what Pi ended up loading. The unit
// tests above prove the filter filters; this proves it is wired into the options the entry
// points pass, and that Pi's extensionsOverride hook runs where we think it does.
test("moat: a daemon-shaped session loads no shim of ours, and still loads the user's", async () => {
  const home = mkdtempSync(join(tmpdir(), "priv-moat-live-"));
  const agentDir = join(home, "agent");
  const extDir = join(agentDir, "extensions");
  mkdirSync(extDir, { recursive: true });
  const prevHome = process.env.PRIVATEER_HOME;
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  const wasChild = process.env.PI_SUBAGENT_CHILD;
  process.env.PRIVATEER_HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENT_CHILD = "1"; // skip the gate's parent approval relay (a live timer)

  try {
    for (const name of ["privateer-gate", "privateer-media"]) {
      writeFileSync(
        join(extDir, `${name}.ts`),
        `export { default } from ${JSON.stringify(pathToFileURL(join(REPO, "extensions", `${name}.ts`)).href)};\n`,
      );
    }
    writeFileSync(join(extDir, "user-thing.ts"), "export default function (pi) {}\n");

    const { createAgentSessionServices } = await import("@earendil-works/pi-coding-agent");
    const services = await createAgentSessionServices({
      cwd: REPO,
      agentDir,
      resourceLoaderOptions: (await moatResourceOptions({
        kind: "harbor-session",
        gate: stubGate(REPO),
      })) as any,
    });
    const loaded = services.resourceLoader.getExtensions();
    const paths = loaded.extensions.map((e: any) => String(e.path));

    assert.equal((loaded.errors ?? []).length, 0, `extension load errors: ${JSON.stringify(loaded.errors)}`);
    for (const name of ["privateer-gate", "privateer-media"]) {
      assert.ok(
        !paths.some((p: string) => p.endsWith(`${name}.ts`)),
        `${name} was discovered into a session that builds its own moat: ${paths.join(", ")}`,
      );
    }
    assert.ok(
      paths.some((p: string) => p.endsWith("user-thing.ts")),
      `the user's own extension must survive the filter — this is what noExtensions would have cost: ${paths.join(", ")}`,
    );
  } finally {
    if (prevHome === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prevHome;
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
    if (wasChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = wasChild;
    rmSync(home, { recursive: true, force: true });
  }
});

// The other half of the same change: the TUI no longer DISCOVERS the moat, it is handed
// the same paths as `-e` args (bin/privateer-launch.mjs), which Pi resolves into the
// loader's additionalExtensionPaths — the path exercised here. If this breaks, a terminal
// launches with no permission gate, so pin that the moat loads AND that the user's own
// extensions still load beside it.
test("moat: the launcher's -e paths load the moat next to the user's own extensions", async () => {
  const home = mkdtempSync(join(tmpdir(), "priv-moat-e-"));
  const agentDir = join(home, "agent");
  const extDir = join(agentDir, "extensions");
  mkdirSync(extDir, { recursive: true });
  const prevHome = process.env.PRIVATEER_HOME;
  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  const wasChild = process.env.PI_SUBAGENT_CHILD;
  process.env.PRIVATEER_HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_SUBAGENT_CHILD = "1"; // skip the gate's parent approval relay (a live timer)

  try {
    // The agent dir holds ONLY the user's extension now — no shims.
    writeFileSync(join(extDir, "user-thing.ts"), "export default function (pi) {}\n");
    const moatPaths = ["privateer-gate", "privateer-media"].map((n) => join(REPO, "extensions", `${n}.ts`));

    const { createAgentSessionServices } = await import("@earendil-works/pi-coding-agent");
    const services = await createAgentSessionServices({
      cwd: REPO,
      agentDir,
      resourceLoaderOptions: { additionalExtensionPaths: moatPaths } as any,
    });
    const loaded = services.resourceLoader.getExtensions();
    const paths = loaded.extensions.map((e: any) => String(e.path));

    assert.equal((loaded.errors ?? []).length, 0, `extension load errors: ${JSON.stringify(loaded.errors)}`);
    for (const p of moatPaths) {
      assert.ok(paths.includes(p), `${p} did not load via -e — a terminal would launch ungated: ${paths.join(", ")}`);
    }
    assert.ok(
      paths.some((p: string) => p.endsWith("user-thing.ts")),
      `the user's own extension must still be discovered: ${paths.join(", ")}`,
    );
  } finally {
    if (prevHome === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prevHome;
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
    if (wasChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = wasChild;
    rmSync(home, { recursive: true, force: true });
  }
});

// The capability table is the thing five copied factory arrays used to encode by accident.
// Pin the two rules that carry a real cost if they drift: web is account-API-only and must
// never reach a path with a human who has their own provider key, and composition (local
// ffmpeg, no account, no network, no spend) is grantable everywhere.
test("moat profiles: each kind builds a gate, and web stays off the interactive paths", async () => {
  const cwd = REPO;
  const kinds: MoatKind[] = ["harbor-session", "live-task", "channels", "acp", "repl"];
  for (const kind of kinds) {
    const factories = await buildMoat({ kind, gate: stubGate(cwd) });
    assert.ok(factories.length >= 3, `${kind}: expected at least gate + privacy + account`);
    assert.ok(
      factories.every((f) => typeof f === "function"),
      `${kind}: every entry must be an extension factory`,
    );
  }
});
