import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideToolCall,
  type GateController,
  type ToolCallCtx,
} from "../src/ext/permissionGate.ts";
import type { PermissionRequest } from "../src/permissions/gate.ts";
import type { AskOutcome } from "../src/permissions/modeGate.ts";
import type { PermissionMode } from "../src/config/permissionMode.ts";

// The gate extension's decision path (classify → ModeGate policy → block/allow),
// including fail-closed behavior and local/remote routing. Pure — no live session.

function makeCtrl(over: Partial<GateController> = {}): GateController & { localAsks: number; remoteAsks: number } {
  let mode: PermissionMode = over.getMode?.() ?? "default";
  const state = {
    localAsks: 0,
    remoteAsks: 0,
    getMode: () => mode,
    setMode: (m: PermissionMode) => (mode = m),
    allowlist: [] as string[],
    allowedOutsideRoots: [] as string[],
    denylist: [] as string[],
    cwd: "/work",
    async localAsk(_req: PermissionRequest, _ctx: ToolCallCtx): Promise<AskOutcome> {
      state.localAsks++;
      return "allow";
    },
    ...over,
  } as GateController & { localAsks: number; remoteAsks: number };
  return state;
}

const noCtx: ToolCallCtx = {};

test("deny → block with a reason", async () => {
  const ctrl = makeCtrl({ localAsk: async () => "deny" });
  const r = await decideToolCall(ctrl, "bash", { command: "ls" }, noCtx);
  assert.equal(r?.block, true);
  assert.match(r!.reason, /denied/i);
});

test("allow → undefined (tool runs)", async () => {
  const ctrl = makeCtrl({ localAsk: async () => "allow" });
  assert.equal(await decideToolCall(ctrl, "bash", { command: "ls" }, noCtx), undefined);
});

test("in-scope read is not gated and never asks", async () => {
  const ctrl = makeCtrl();
  const r = await decideToolCall(ctrl, "read", { path: "src/a.ts" }, noCtx);
  assert.equal(r, undefined);
  assert.equal(ctrl.localAsks, 0);
});

test("bypass mode auto-allows without asking", async () => {
  const ctrl = makeCtrl({ getMode: () => "bypass" });
  const r = await decideToolCall(ctrl, "write", { path: "a.ts" }, noCtx);
  assert.equal(r, undefined);
  assert.equal(ctrl.localAsks, 0);
});

test("plan mode blocks a mutation without asking", async () => {
  const ctrl = makeCtrl({ getMode: () => "plan" });
  const r = await decideToolCall(ctrl, "write", { path: "a.ts" }, noCtx);
  assert.equal(r?.block, true);
  assert.equal(ctrl.localAsks, 0);
});

test("fail closed when the asker throws", async () => {
  const ctrl = makeCtrl({
    localAsk: async () => {
      throw new Error("ui exploded");
    },
  });
  const r = await decideToolCall(ctrl, "bash", { command: "ls" }, noCtx);
  assert.equal(r?.block, true);
  assert.match(r!.reason, /blocked by default/i);
});

test("fail closed on approval timeout", async () => {
  const ctrl = makeCtrl({
    approvalTimeoutMs: 20,
    localAsk: () => new Promise<AskOutcome>(() => {}), // never resolves
  });
  const r = await decideToolCall(ctrl, "bash", { command: "ls" }, noCtx);
  assert.equal(r?.block, true);
  assert.match(r!.reason, /timeout|blocked by default/i);
});

test("fail closed when the turn is aborted mid-approval", async () => {
  const ac = new AbortController();
  const ctrl = makeCtrl({
    localAsk: () => new Promise<AskOutcome>(() => {}), // hangs until abort
  });
  const p = decideToolCall(ctrl, "bash", { command: "ls" }, { signal: ac.signal });
  ac.abort();
  const r = await p;
  assert.equal(r?.block, true);
});

test("remote turn routes to remoteAsk, not localAsk", async () => {
  const ctrl = makeCtrl({
    getRemote: () => true,
    remoteAsk: async () => "allow",
  });
  const r = await decideToolCall(ctrl, "bash", { command: "npm test" }, noCtx);
  assert.equal(r, undefined);
  assert.equal(ctrl.remoteAsks, 0); // counter not used, but localAsk must be untouched
  assert.equal(ctrl.localAsks, 0);
});

test("remote turn blocks a remote-unsafe tool before it can ask", async () => {
  // A subagent tool on a driven turn must be blocked outright (not relayed for
  // approval) — its own prompts would surface on the host terminal, invisible to
  // the driver. The block is fail-closed and fires the onRemoteBlocked notice.
  let blockedTool: string | undefined;
  const ctrl = makeCtrl({
    getRemote: () => true,
    remoteAsk: async () => "allow", // must NOT be consulted
    blockedWhenRemote: (name) => name === "subagent",
    onRemoteBlocked: (name) => { blockedTool = name; },
  });
  const r = await decideToolCall(ctrl, "subagent", { action: "list" }, noCtx);
  assert.equal(r?.block, true);
  assert.match(r!.reason, /driven remotely|unavailable/i);
  assert.equal(blockedTool, "subagent");
  assert.equal(ctrl.localAsks, 0);
});

test("a remote-unsafe tool still runs on a LOCAL turn", async () => {
  // Not driven → blockedWhenRemote is never consulted; the tool is gated normally
  // (classified unknown → asks) and the local approval decides it.
  let blocked = false;
  const ctrl = makeCtrl({
    getRemote: () => false,
    blockedWhenRemote: () => { blocked = true; return true; },
    localAsk: async () => "allow",
  });
  const r = await decideToolCall(ctrl, "subagent", { action: "list" }, noCtx);
  assert.equal(r, undefined);
  assert.equal(blocked, false);
});

test("headless default asker (no ui) fails closed to deny", async () => {
  // Uses the real defaultLocalAsk via makePermissionGate's default assignment path:
  // here we simulate a controller whose localAsk is the default (no ui in ctx).
  const { defaultLocalAsk } = await import("../src/ext/permissionGate.ts");
  const outcome = await defaultLocalAsk(
    { tool: "bash", kind: "bash", title: "Run", detail: "ls" },
    { hasUI: false },
  );
  assert.equal(outcome, "deny");
});

// ── Pre-authorized spend (unattended runs) ───────────────────────────────────
// The billing media tools are `alwaysAsk`, which outranks bypass mode — so in an
// unattended harbor run (bypass + a fail-closed asker) a routine could NAME
// generate_video and then have every call denied. isSpendPreauthorized lifts that one
// veto for tools the operator authorized in advance. These tests pin the guards, because
// each one is the difference between "spend what you were told you may" and a hole.

// A harbor run's gate: bypass mode, nobody to ask, confined to its cwd.
function unattended(over: Partial<GateController> = {}): GateController & { localAsks: number } {
  return makeCtrl({
    getMode: () => "bypass",
    confineToCwd: true,
    localAsk: async () => "deny",
    ...over,
  });
}

test("an unattended run denies a billing media tool it was not granted", async () => {
  const r = await decideToolCall(unattended(), "generate_video", { prompt: "a ship", path: "out.mp4" }, noCtx);
  assert.equal(r?.block, true, "no grant → the alwaysAsk veto stands, even in bypass");
  assert.match(r!.reason, /denied by the permission gate/);
});

test("an unattended run may spend on a tool it was granted, and only that tool", async () => {
  const ctrl = unattended({ isSpendPreauthorized: (req) => req.tool === "generate_sfx" });
  assert.equal(
    await decideToolCall(ctrl, "generate_sfx", { prompt: "rain", path: "rain.mp3" }, noCtx),
    undefined,
    "the granted tool runs without asking anyone",
  );
  // The grant is per NAME: granting the cheap tool must not grant the dear one.
  assert.equal(
    (await decideToolCall(ctrl, "generate_video", { prompt: "a ship", path: "out.mp4" }, noCtx))?.block,
    true,
  );
  assert.equal(ctrl.localAsks, 0, "an unattended run must never wait on a prompt nobody can answer");
});

test("a grant does not survive plan mode", async () => {
  // plan is a hard deny before any of this, so a read-only stance can't be spent around.
  const ctrl = unattended({ getMode: () => "plan", isSpendPreauthorized: () => true });
  assert.equal((await decideToolCall(ctrl, "generate_image", { prompt: "x", path: "a.png" }, noCtx))?.block, true);
});

test("a grant does not survive leaving the working directory or touching a protected file", async () => {
  const ctrl = unattended({ isSpendPreauthorized: () => true });
  // Output outside cwd. bypass mode alone WOULD allow this, so the guard has to be
  // explicit rather than inherited from the mode.
  assert.equal(
    (await decideToolCall(ctrl, "generate_image", { prompt: "x", path: "/elsewhere/a.png" }, noCtx))?.block,
    true,
    "\"you may generate images\" must not become \"you may write anywhere\"",
  );
  // An input read from outside scope — the exfil direction: a reference image is
  // base64'd up to our servers.
  assert.equal(
    (await decideToolCall(ctrl, "generate_video", { prompt: "x", path: "out.mp4", images: ["/etc/passwd"] }, noCtx))
      ?.block,
    true,
  );
  // A protected file inside cwd is still protected.
  assert.equal(
    (await decideToolCall(ctrl, "generate_image", { prompt: "x", path: "logo.png", input: "/work/.env" }, noCtx))
      ?.block,
    true,
  );
});

test("a grant never silences an interactive session's prompt", async () => {
  // Default mode with a human: the grant must not turn a terminal into one that bills
  // without asking, however the env or a controller came to set it.
  // makeCtrl's default localAsk counts and allows, so this distinguishes "allowed after
  // asking" from "allowed without asking" — which is the whole point.
  const ctrl = makeCtrl({ isSpendPreauthorized: () => true });
  assert.equal(await decideToolCall(ctrl, "generate_video", { prompt: "x", path: "out.mp4" }, noCtx), undefined);
  assert.equal(ctrl.localAsks, 1, "the human was asked");
});

test("a grant never pre-empts the app on a driven turn", async () => {
  // A remote-driven turn has someone holding the phone; they get the decision.
  const ctrl = makeCtrl({
    getMode: () => "bypass",
    getRemote: () => true,
    isSpendPreauthorized: () => true,
    remoteAsk: async () => "deny",
  });
  assert.equal((await decideToolCall(ctrl, "generate_video", { prompt: "x", path: "out.mp4" }, noCtx))?.block, true);
});

test("a grant does not extend to dangerous shell", async () => {
  // isSpendPreauthorized is consulted for every alwaysAsk request, so a controller that
  // returned true for everything must still not get dangerous bash through: that path
  // reaches "ask" via isDangerousCommand, not via alwaysAsk.
  const ctrl = unattended({ isSpendPreauthorized: () => true, denylist: undefined });
  assert.equal((await decideToolCall(ctrl, "bash", { command: "rm -rf /" }, noCtx))?.block, true);
});
