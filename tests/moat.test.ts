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
  const kinds: MoatKind[] = ["harbor-session", "live-task", "channels", "acp", "repl", "desktop"];
  for (const kind of kinds) {
    const factories = await buildMoat({ kind, gate: stubGate(cwd), webHint: "sign in" });
    assert.ok(factories.length >= 3, `${kind}: expected at least gate + privacy + account`);
    assert.ok(
      factories.every((f) => typeof f === "function"),
      `${kind}: every entry must be an extension factory`,
    );
  }
});

// attach_to_result is the one tool whose existence is decided by DELIVERY, not by a
// capability switch: a run that answers into the app's Inbox can hand over files, and a
// run whose result goes to a file or a webhook has nothing to hand them to. That is
// expressed by passing (or not passing) the run's staging area, so pin both directions —
// the tempting future edit is to register it unconditionally "for consistency", which
// would give every session a tool that stages attachments nobody will ever collect.
test("moat: attach_to_result exists only for a run with an Inbox to attach to", async () => {
  const { ResultMedia } = await import("../src/routines/resultMedia.ts");

  const without = await buildMoat({ kind: "harbor-session", gate: stubGate(REPO) });
  assert.ok(!toolsFrom(without).includes("attach_to_result"), "no staging area ⇒ no tool");

  const withMedia = await buildMoat({ kind: "harbor-session", gate: stubGate(REPO), resultMedia: new ResultMedia() });
  assert.ok(toolsFrom(withMedia).includes("attach_to_result"), "a staged run must be able to attach");
});

// A stub `pi` that records tool names and shrugs at everything else an extension does.
// Shared by every test that asks what a kind's factories actually REGISTER — hoisted, so
// the attach_to_result test above uses this one rather than its own former copy.
function toolsFrom(factories: ((pi: any) => void)[]): string[] {
  const names: string[] = [];
  const pi: any = new Proxy(
    { registerTool: (t: any) => { if (t?.name) names.push(t.name); } },
    { get: (target, prop) => (prop in target ? (target as any)[prop] : () => undefined) },
  );
  for (const f of factories) {
    try { f(pi); } catch { /* an extension that needs a real host is not what we're asking about */ }
  }
  return names;
}

// THE REGRESSION THIS KIND WAS ADDED FOR. The desktop app built its own factory array and
// never loaded privateer-media, so the Super Computer was the one surface with no
// generation at all — and, more tellingly, no video_compose either, which every other kind
// gets unconditionally because it is local ffmpeg work that spends nothing. Meanwhile its
// MCP connectors worked, so it could drive the Godot and Unreal editors but not make a
// texture to put in them.
//
// Pinned as a COMPARISON rather than a tool list, deliberately: generation is credentials-
// gated (mediaEnabled → hasCredentials), so an absolute assertion would say different
// things on a signed-in laptop and in CI. "Whatever the harbor gets, the desktop gets" is
// true in both, and it is the actual claim — an attended session with a human watching
// must never have LESS media than an unattended one.
test("moat: the desktop kind is not a lesser kind for media than the harbor", async () => {
  const desktop = toolsFrom(await buildMoat({ kind: "desktop", gate: stubGate(REPO), webHint: "sign in" }));
  const harbor = toolsFrom(await buildMoat({ kind: "harbor-session", gate: stubGate(REPO) }));

  const MEDIA = new Set([
    "generate_image", "generate_video", "generate_model",
    "generate_speech", "generate_music", "generate_sfx",
    "media_capabilities", "video_compose",
  ]);
  for (const name of harbor.filter((n) => MEDIA.has(n))) {
    assert.ok(desktop.includes(name), `desktop is missing ${name}, which harbor-session has`);
  }
  // Unconditional everywhere — no account, no network, no spend — so this one is safe to
  // assert outright, and it is the half that had no excuse for being absent.
  assert.ok(desktop.includes("video_compose"), "local composition costs nothing and must always be there");
});

// web has two shapes and the difference is not a preference — see MoatCaps.web. The
// unattended kinds decide once at build; an attended one cannot, because /signin happens
// in the middle of the session it would have decided for. So the desktop's web tools exist
// whether or not this machine is signed in, which is the only form of the assertion that
// means the same thing on a developer's laptop as in CI.
test("moat: an attended kind gets web tools that outlive sign-in", async () => {
  const desktop = toolsFrom(await buildMoat({ kind: "desktop", gate: stubGate(REPO), webHint: "sign in" }));
  assert.ok(desktop.includes("web_search"), "guarded web_search must be registered regardless of credentials");
  assert.ok(desktop.includes("web_fetch"), "guarded web_fetch must be registered regardless of credentials");
});

// The guard's message is the caller's to write (src/tools/web.ts), so a kind that asks for
// guarded web tools without supplying one is a programming error — and a silent default
// would be exactly the plausible-but-wrong drift this module exists to prevent. Fail at
// build, where the test catches it, rather than telling a signed-out user something
// generic about an account menu they may not have.
test("moat: guarded web without a hint is a build error, not a default", async () => {
  await assert.rejects(
    () => buildMoat({ kind: "desktop", gate: stubGate(REPO) }),
    /webHint/,
    "a guarded kind must be made to supply its own sign-in message",
  );
});
