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
