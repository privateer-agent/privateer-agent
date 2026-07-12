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
  const notices: string[] = [];
  const commandLists: { name: string; description?: string }[][] = [];
  const selects: { id: string; req: any }[] = [];
  const inputs: { id: string; req: any }[] = [];
  const extensions: any[] = [];
  const skills: any[] = [];
  let connected = true;
  const relay: RelayLike & {
    approvals: typeof approvals; events: typeof events; noQuarter: typeof noQuarter;
    notices: typeof notices; commandLists: typeof commandLists; selects: typeof selects;
    inputs: typeof inputs; extensions: typeof extensions; skills: typeof skills;
    setConnected(v: boolean): void;
  } = {
    approvals,
    events,
    noQuarter,
    notices,
    commandLists,
    selects,
    inputs,
    extensions,
    skills,
    setConnected(v) { connected = v; },
    requestApproval(id, req) { approvals.push({ id, req }); },
    sendEvent(ev) { events.push(ev); },
    isConnected() { return connected; },
    sendNoQuarter(on) { noQuarter.push(on); },
    async sendFile() { return { ok: connected }; },
    sendNotice(text) { notices.push(text); },
    sendCommands(commands) { commandLists.push(commands); },
    requestSelect(id, req) { selects.push({ id, req }); },
    requestInput(id, req) { inputs.push({ id, req }); },
    sendExtensions(payload) { extensions.push(payload); },
    sendSkills(payload) { skills.push(payload); },
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

test("onCommand routes an app slash-command to the dispatcher", () => {
  const seen: string[] = [];
  const bridge = new RemoteBridge({ onPrompt: () => {}, onCommand: (t) => seen.push(t) });
  bridge.attachRelay(makeFakeRelay());
  bridge.callbacks.onCommand("/model openrouter/openai/gpt-4o");
  assert.deepEqual(seen, ["/model openrouter/openai/gpt-4o"]);
});

test("selectRemote relays options and resolves on the app's choice", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  const p = bridge.selectRemote({ title: "Model", options: [{ value: "a/b", label: "a/b" }] });
  await tick();
  assert.equal(relay.selects.length, 1);
  bridge.callbacks.onSelectResponse(relay.selects[0].id, "a/b");
  assert.equal(await p, "a/b");
});

test("selectRemote fails to null with no connected controller", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  relay.setConnected(false);
  bridge.attachRelay(relay);
  assert.equal(await bridge.selectRemote({ title: "M", options: [] }), null);
});

test("a disconnect resolves pending selects to null", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  const p = bridge.selectRemote({ title: "M", options: [{ value: "x", label: "x" }] });
  await tick();
  bridge.callbacks.onDisconnected();
  assert.equal(await p, null);
});

test("inputRemote relays the prompt and resolves on the app's submission", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  const p = bridge.inputRemote({ title: "Name", placeholder: "e.g. main" });
  await tick();
  assert.equal(relay.inputs.length, 1);
  bridge.callbacks.onInputResponse(relay.inputs[0].id, "release");
  assert.equal(await p, "release");
});

test("inputRemote fails to null with no connected controller", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  relay.setConnected(false);
  bridge.attachRelay(relay);
  assert.equal(await bridge.inputRemote({ title: "Name" }), null);
});

test("a disconnect resolves pending inputs to null", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  const p = bridge.inputRemote({ title: "Name" });
  await tick();
  bridge.callbacks.onDisconnected();
  assert.equal(await p, null);
});

test("sendNotice / sendCommands pass through to the relay", () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  bridge.sendNotice("model → a/b");
  bridge.sendCommands([{ name: "/model", description: "Switch the model" }]);
  assert.deepEqual(relay.notices, ["model → a/b"]);
  assert.deepEqual(relay.commandLists, [[{ name: "/model", description: "Switch the model" }]]);
});

test("extensions_* callbacks route to the config handlers", () => {
  const listed: number[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const bridge = new RemoteBridge({
    onPrompt: () => {},
    onExtensionsList: () => listed.push(1),
    onExtensionsAdd: (s) => added.push(s),
    onExtensionsRemove: (s) => removed.push(s),
  });
  bridge.attachRelay(makeFakeRelay());
  bridge.callbacks.onExtensionsList();
  bridge.callbacks.onExtensionsAdd("npm:pi-hello");
  bridge.callbacks.onExtensionsRemove("npm:pi-hello");
  assert.deepEqual(listed, [1]);
  assert.deepEqual(added, ["npm:pi-hello"]);
  assert.deepEqual(removed, ["npm:pi-hello"]);
});

test("sendExtensions passes the installed snapshot through to the relay", () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  bridge.sendExtensions({ installed: [{ source: "npm:pi-hello", scope: "user" }], needsRestart: true, message: "Restart to activate." });
  assert.equal(relay.extensions.length, 1);
  assert.deepEqual(relay.extensions[0].installed, [{ source: "npm:pi-hello", scope: "user" }]);
  assert.equal(relay.extensions[0].needsRestart, true);
});

test("skills_* callbacks route to the config handlers", () => {
  const listed: number[] = [];
  const created: any[] = [];
  const deleted: string[] = [];
  const toggled: { name: string; enabled: boolean }[] = [];
  const bridge = new RemoteBridge({
    onPrompt: () => {},
    onSkillsList: () => listed.push(1),
    onSkillCreate: (s) => created.push(s),
    onSkillDelete: (n) => deleted.push(n),
    onSkillSetEnabled: (n, e) => toggled.push({ name: n, enabled: e }),
  });
  bridge.attachRelay(makeFakeRelay());
  bridge.callbacks.onSkillsList();
  bridge.callbacks.onSkillCreate({ name: "pdf-tools", description: "d", instructions: "b" });
  bridge.callbacks.onSkillDelete("pdf-tools");
  bridge.callbacks.onSkillSetEnabled("pdf-tools", false);
  assert.deepEqual(listed, [1]);
  assert.deepEqual(created, [{ name: "pdf-tools", description: "d", instructions: "b" }]);
  assert.deepEqual(deleted, ["pdf-tools"]);
  assert.deepEqual(toggled, [{ name: "pdf-tools", enabled: false }]);
});

test("sendSkills passes the skills snapshot through to the relay", () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  bridge.sendSkills({ items: [{ name: "pdf-tools", description: "d", source: "user", editable: true, disabled: false }], needsRestart: true });
  assert.equal(relay.skills.length, 1);
  assert.equal(relay.skills[0].items[0].name, "pdf-tools");
  assert.equal(relay.skills[0].needsRestart, true);
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
