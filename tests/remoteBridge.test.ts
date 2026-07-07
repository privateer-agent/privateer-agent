import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteBridge, type RelayLike } from "../src/remote/remoteBridge.ts";
import { decideToolCall, type GateController } from "../src/ext/permissionGate.ts";
import type { PermissionRequest } from "../src/permissions/gate.ts";
import type { EngineEvent } from "../src/engine/events.ts";

// The RelayClient is KEEP (verbatim 0.2); the RemoteBridge is the new wiring, so
// that's what we exercise — against a fake relay standing in for the app/WS. The
// headline test drives the REAL Phase-2 gate through the bridge's remote branch.

function makeFakeRelay() {
  const approvals: { id: string; req: PermissionRequest }[] = [];
  const events: EngineEvent[] = [];
  const noQuarter: boolean[] = [];
  let connected = true;
  const relay: RelayLike & { approvals: typeof approvals; events: typeof events; noQuarter: typeof noQuarter; setConnected(v: boolean): void } = {
    approvals,
    events,
    noQuarter,
    setConnected(v) { connected = v; },
    requestApproval(id, req) { approvals.push({ id, req }); },
    sendEvent(ev) { events.push(ev); },
    isConnected() { return connected; },
    sendNoQuarter(on) { noQuarter.push(on); },
  };
  return relay;
}

const tick = () => new Promise((r) => setImmediate(r));

test("onPrompt marks the turn remote and delivers buffered attachments", () => {
  let got: { text: string; atts: number } | undefined;
  const bridge = new RemoteBridge({ onPrompt: (text, atts) => (got = { text, atts: atts.length }) });
  bridge.attachRelay(makeFakeRelay());
  assert.equal(bridge.getRemote(), false);
  bridge.callbacks.onAttachment({ name: "a.txt", mediaType: "text/plain", base64: "eA==" });
  bridge.callbacks.onPrompt("do it");
  assert.equal(bridge.getRemote(), true);
  assert.deepEqual(got, { text: "do it", atts: 1 });
});

test("forwardEvent sends up through the relay", () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  bridge.forwardEvent({ type: "text", text: "hi" });
  assert.equal(relay.events.length, 1);
});

test("no_quarter toggles state and echoes the ack", () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  bridge.callbacks.onNoQuarter(true);
  assert.equal(bridge.getNoQuarter(), true);
  assert.deepEqual(relay.noQuarter, [true]);
});

test("remoteAsk fails closed with no connected controller", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  relay.setConnected(false);
  bridge.attachRelay(relay);
  const d = await bridge.remoteAsk({ tool: "bash", kind: "bash", title: "Run", detail: "ls" });
  assert.equal(d, "deny");
});

test("remoteAsk relays and resolves on the app's response", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  const p = bridge.remoteAsk({ tool: "bash", kind: "bash", title: "Run", detail: "npm test" });
  await tick();
  assert.equal(relay.approvals.length, 1);
  bridge.callbacks.onApprovalResponse(relay.approvals[0].id, "allow");
  assert.equal(await p, "allow");
});

test("a disconnect fails all pending approvals closed", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  const p = bridge.remoteAsk({ tool: "bash", kind: "bash", title: "Run", detail: "x" });
  await tick();
  bridge.callbacks.onDisconnected();
  assert.equal(await p, "deny");
});

// ── the payoff: the real Phase-2 gate, driven remotely through the bridge ──

function remoteGate(bridge: RemoteBridge): GateController {
  return {
    getMode: () => "default",
    setMode: () => {},
    allowlist: [],
    allowedOutsideRoots: [],
    cwd: "/work",
    async localAsk() { return "deny"; }, // must NOT be used on a remote turn
    getRemote: bridge.getRemote,
    remoteAsk: bridge.remoteAsk,
  };
}

test("remote turn: app DENY blocks the tool", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  bridge.callbacks.onPrompt("delete stuff"); // remote turn in flight
  const p = decideToolCall(remoteGate(bridge), "bash", { command: "rm -rf x" }, {});
  await tick();
  assert.equal(relay.approvals.length, 1, "tool relayed to the app");
  bridge.callbacks.onApprovalResponse(relay.approvals[0].id, "deny");
  const res = await p;
  assert.equal(res?.block, true);
});

test("remote turn: app ALLOW runs the tool", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  bridge.callbacks.onPrompt("do it");
  const p = decideToolCall(remoteGate(bridge), "bash", { command: "npm test" }, {});
  await tick();
  bridge.callbacks.onApprovalResponse(relay.approvals[0].id, "allow");
  assert.equal(await p, undefined); // undefined → tool proceeds
});

test("remote turn still hard-denies plan mode without relaying", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  bridge.callbacks.onPrompt("x");
  const ctrl = { ...remoteGate(bridge), getMode: () => "plan" as const };
  const res = await decideToolCall(ctrl, "write", { path: "a.ts" }, {});
  assert.equal(res?.block, true);
  assert.equal(relay.approvals.length, 0); // read-only stance can't be talked around remotely
});
