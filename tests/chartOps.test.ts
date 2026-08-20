import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteBridge, type RelayLike } from "../src/remote/remoteBridge.ts";
import {
  makeCreateChartTool,
  makeEditChartTool,
  makeListChartsTool,
  makeReadChartTool,
} from "../src/tools/charts.ts";
import { classifyToolCall } from "../src/permissions/classify.ts";
import { MAX_NODES_PER_OP, parseChartResult, validateNewNode } from "../src/remote/chartOps.ts";

// The chart tools share save_cargo's premise — the CLI cannot do the work itself, because
// it holds no master key — and add one of their own: they READ the user's stored content
// back. So what's worth testing is the round trip, every way it fails without the user's
// chart changing, and the validation that stops a malformed card from being written at
// all (a card that renders blank is discovered late, on a phone, by the user).

function makeFakeRelay(opts: { connected?: boolean; controller?: boolean } = {}) {
  let connected = opts.connected ?? true;
  const controller = opts.controller ?? true;
  const chartOps: { id: string; req: any }[] = [];
  const relay: RelayLike & { chartOps: typeof chartOps; setConnected(v: boolean): void } = {
    chartOps,
    setConnected(v) { connected = v; },
    requestApproval() {},
    sendEvent() {},
    isConnected() { return connected; },
    hasController() { return connected && controller; },
    sendNoQuarter() {},
    async sendFile() { return { ok: true }; },
    sendNotice() {},
    sendCommands() {},
    requestSelect() {},
    requestInput() {},
    sendExtensions() {},
    sendSkills() {},
    sendFileMatches() {},
    requestCargoSave() {},
    requestChartOp(id, req) { chartOps.push({ id, req }); },
  };
  return relay;
}

const tick = () => new Promise((r) => setImmediate(r));
const textOf = (res: any): string => res.content[0].text;

// ── the round trip ───────────────────────────────────────────────────────────

test("chartOpRemote relays the op and resolves on the app's answer", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);

  const p = bridge.chartOpRemote({ op: "read", chartId: "a".repeat(24) });
  await tick();

  assert.equal(relay.chartOps.length, 1);
  const { id, req } = relay.chartOps[0];
  assert.equal(req.op, "read");

  bridge.callbacks.onChartResult!(id, {
    ok: true, op: "read",
    chart: { chartId: "a".repeat(24), title: "Auth", nodeCount: 1 },
    nodes: [{ nodeId: "b".repeat(24), kind: "note", text: "hi" }],
    edges: [],
  });
  const out = await p;
  assert.equal(out.ok, true);
});

test("a reply on an unknown id doesn't settle someone else's op", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  bridge.attachRelay(makeFakeRelay());
  let settled = false;
  void bridge.chartOpRemote({ op: "list" }).then(() => { settled = true; });
  await tick();
  bridge.callbacks.onChartResult!("not-the-id", { ok: false, reason: "nope" });
  await tick();
  assert.equal(settled, false);
});

test("no attached app refuses immediately rather than waiting out the deadline", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  bridge.attachRelay(makeFakeRelay({ controller: false }));
  const res = await bridge.chartOpRemote({ op: "list" });
  assert.equal(res.ok, false);
  assert.match((res as any).reason, /not attached/);
});

test("a disconnect mid-op reports an UNKNOWN outcome, not a failure", async () => {
  // An edit applies its steps in order, so a dropped socket can leave a chart partly
  // changed. Reporting "it failed" would get a retry that re-adds every card that landed.
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  bridge.attachRelay(makeFakeRelay());
  const p = bridge.chartOpRemote({ op: "edit", chartId: "a".repeat(24), ops: [{ edit: "rename", title: "x" }] });
  await tick();
  bridge.callbacks.onDisconnected!();
  const res = await p;
  assert.equal(res.ok, false);
  assert.match((res as any).reason, /may already have been applied/);
});

test("an aborted turn settles the op instead of leaving it pending", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  bridge.attachRelay(makeFakeRelay());
  const ac = new AbortController();
  const p = bridge.chartOpRemote({ op: "list" }, ac.signal);
  await tick();
  ac.abort();
  const res = await p;
  assert.equal(res.ok, false);
  assert.match((res as any).reason, /interrupted/);
});

// ── card validation ──────────────────────────────────────────────────────────

test("a note card must carry body, and only body", () => {
  assert.equal(validateNewNode({ kind: "note", body: "text" }, "n"), null);
  assert.match(validateNewNode({ kind: "note" }, "n")!, /needs `body`/);
  // The failure this exists to stop: text arriving in the wrong field stores a blank card.
  assert.match(validateNewNode({ kind: "note", body: "a", answer: "b" }, "n")!, /takes `body` only/);
});

test("an answer card must carry both halves of the pair", () => {
  assert.equal(validateNewNode({ kind: "answer", prompt: "q", answer: "a" }, "n"), null);
  assert.match(validateNewNode({ kind: "answer", prompt: "q" }, "n")!, /needs `answer`/);
  assert.match(validateNewNode({ kind: "answer", answer: "a" }, "n")!, /needs `prompt`/);
  assert.match(validateNewNode({ kind: "answer", prompt: "q", answer: "a", body: "b" }, "n")!, /use kind "note"/);
});

test("an unknown kind is refused with the real ones named", () => {
  // The server's nodeType enum is deliberately NOT what the model speaks; 'image' and
  // 'drawing' are the two it is most likely to reach for, and both must bounce.
  assert.match(validateNewNode({ kind: "image" } as any, "n")!, /note, answer/);
  assert.match(validateNewNode({ kind: "drawing" } as any, "n")!, /note, answer/);
});

// ── the tools ────────────────────────────────────────────────────────────────

function toolBridge(answer: any) {
  const calls: any[] = [];
  return {
    calls,
    async chartOpRemote(req: any) { calls.push(req); return answer; },
  };
}

test("create_chart refuses a bad card before anything reaches the app", async () => {
  const bridge = toolBridge({ ok: true, op: "create", chartId: "x", title: "t", nodeIds: [], storageType: "cloud" });
  const tool = makeCreateChartTool(bridge);
  const res = await tool.execute("1", { nodes: [{ kind: "note" } as any] });
  assert.match(textOf(res), /needs `body`/);
  assert.equal(bridge.calls.length, 0); // nothing was sent
});

test("create_chart refuses an edge naming a ref nobody declared", async () => {
  const bridge = toolBridge({ ok: true, op: "create", chartId: "x", title: "t", nodeIds: [], storageType: "cloud" });
  const res = await makeCreateChartTool(bridge).execute("1", {
    nodes: [{ kind: "note", body: "a", ref: "one" }],
    edges: [{ from: "one", to: "two" }],
  });
  assert.match(textOf(res), /neither a `ref`/);
  assert.equal(bridge.calls.length, 0);
});

test("create_chart caps how many cards one call can add", async () => {
  const bridge = toolBridge({ ok: true, op: "create", chartId: "x", title: "t", nodeIds: [], storageType: "cloud" });
  const nodes = Array.from({ length: MAX_NODES_PER_OP + 1 }, (_, i) => ({ kind: "note" as const, body: `card ${i}` }));
  const res = await makeCreateChartTool(bridge).execute("1", { nodes });
  assert.match(textOf(res), /more than one call can add/);
  assert.equal(bridge.calls.length, 0);
});

test("create_chart reports where the chart landed", async () => {
  const bridge = toolBridge({ ok: true, op: "create", chartId: "cid", title: "Auth flow", nodeIds: ["a", "b"], storageType: "cloud" });
  const res = await makeCreateChartTool(bridge).execute("1", {
    nodes: [{ kind: "note", body: "root", ref: "r" }, { kind: "answer", prompt: "q", answer: "a", parent: "r" }],
  });
  assert.match(textOf(res), /Auth flow/);
  assert.match(textOf(res), /2 cards/);
  assert.match(textOf(res), /cid/);
});

test("a refusal from the app is handed to the model verbatim", async () => {
  const res = await makeCreateChartTool(toolBridge({ ok: false, reason: "the app is locked on this device" }))
    .execute("1", { nodes: [{ kind: "note", body: "x" }] });
  assert.match(textOf(res), /the app is locked on this device/);
});

test("read_chart renders an outline rather than JSON", async () => {
  const res = await makeReadChartTool(toolBridge({
    ok: true, op: "read",
    chart: { chartId: "cid", title: "Auth", nodeCount: 2 },
    nodes: [
      { nodeId: "n1", kind: "note", text: "the note" },
      { nodeId: "n2", kind: "answer", text: "the answer", prompt: "the question" },
    ],
    edges: [{ from: "n1", to: "n2", label: "leads to", directional: true }],
  })).execute("1", { chartId: "cid" });
  const out = textOf(res);
  assert.match(out, /Chart "Auth"/);
  assert.match(out, /\[answer\] n2 — the question/);
  assert.match(out, /n1 → n2 \(leads to\)/);
});

test("list_charts says so plainly when there are none", async () => {
  const res = await makeListChartsTool(toolBridge({ ok: true, op: "list", charts: [] })).execute("1", {} as never);
  assert.match(textOf(res), /No charts yet/);
});

test("edit_chart refuses a step that is missing what it needs", async () => {
  const bridge = toolBridge({ ok: true, op: "edit", chartId: "c", applied: 0, nodeIds: [] });
  const tool = makeEditChartTool(bridge);
  assert.match(textOf(await tool.execute("1", { chartId: "c", ops: [{ edit: "update_node" }] })), /needs `nodeId`/);
  assert.match(textOf(await tool.execute("1", { chartId: "c", ops: [{ edit: "delete_node" }] })), /needs `nodeId`/);
  assert.match(textOf(await tool.execute("1", { chartId: "c", ops: [{ edit: "rename" }] })), /needs `title`/);
  assert.match(textOf(await tool.execute("1", { chartId: "c", ops: [{ edit: "explode" }] })), /is not an edit/);
  assert.equal(bridge.calls.length, 0);
});

test("edit_chart refuses a nodeId that isn't one, rather than letting Mongo cast-error", async () => {
  // The server has no cheaper answer than a 500 for "node-1": it fails the ObjectId
  // cast. By then earlier steps have already been applied, and the model is handed
  // "Server error: 500", which it cannot act on.
  const bridge = toolBridge({ ok: true, op: "edit", chartId: "c", applied: 0, nodeIds: [] });
  const tool = makeEditChartTool(bridge);
  for (const edit of ["update_node", "delete_node"]) {
    const res = await tool.execute("1", { chartId: "c", ops: [{ edit, nodeId: "node-1", body: "x" }] });
    assert.match(textOf(res), /is not a node id/);
  }
  assert.equal(bridge.calls.length, 0);
  // A real id still passes.
  const ok = await tool.execute("1", { chartId: "c", ops: [{ edit: "delete_node", nodeId: "a".repeat(24) }] });
  assert.doesNotMatch(textOf(ok), /is not a node id/);
});

test("edit_chart lets a later step connect a card an earlier step added", async () => {
  const bridge = toolBridge({ ok: true, op: "edit", chartId: "c", applied: 2, nodeIds: ["n1"] });
  const res = await makeEditChartTool(bridge).execute("1", {
    chartId: "c",
    ops: [
      { edit: "add_node", node: { kind: "note", body: "new", ref: "fresh" } },
      { edit: "connect", edge: { from: "fresh", to: "f".repeat(24) } },
    ],
  });
  assert.match(textOf(res), /Applied 2 of 2 steps/);
  assert.equal(bridge.calls.length, 1);
});

// ── parsing the app's answer ─────────────────────────────────────────────────

test("a malformed answer degrades to a refusal with a reason", () => {
  assert.deepEqual(parseChartResult(null), { ok: false, reason: "the app sent an unreadable answer" });
  assert.equal(parseChartResult({ ok: false }).ok, false);
  // An ok:true whose op nobody here understands must not be reported as success.
  assert.equal(parseChartResult({ ok: true, op: "teleport" }).ok, false);
  // ...nor a create with no id to hand back.
  assert.equal(parseChartResult({ ok: true, op: "create" }).ok, false);
});

test("junk inside a well-formed answer is dropped, not passed through", () => {
  const r = parseChartResult({
    ok: true, op: "read",
    chart: { chartId: "c", title: "T", nodeCount: 3 },
    nodes: [{ nodeId: "n1", kind: "note", text: "a" }, { kind: "note", text: "no id" }],
    edges: [{ from: "n1", to: "n2" }, { from: "n1" }],
  });
  assert.equal(r.ok, true);
  assert.equal((r as any).nodes.length, 1);
  assert.equal((r as any).edges.length, 1);
  assert.equal((r as any).edges[0].directional, true); // default when unstated
});

// ── permissions ──────────────────────────────────────────────────────────────

test("the reads classify as reads, so plan mode doesn't deny them", () => {
  const scope = { cwd: process.cwd(), roots: [process.cwd()] } as any;
  const list = classifyToolCall("list_charts", {}, scope);
  assert.ok(list, "list_charts must be classified, not left to the unknown-tool branch");
  assert.equal(list.kind, "read");
  const read = classifyToolCall("read_chart", { chartId: "cid" }, scope);
  assert.ok(read);
  assert.equal(read.kind, "read");
  assert.match(read.detail!, /cid/);
});

test("the writes classify as writes, and a delete says so in the title", () => {
  const scope = { cwd: process.cwd(), roots: [process.cwd()] } as any;
  const create = classifyToolCall("create_chart", { nodes: [{}, {}], title: "Auth" }, scope);
  assert.ok(create);
  assert.equal(create.kind, "write");
  assert.match(create.detail!, /2 cards/);

  const plain = classifyToolCall("edit_chart", { chartId: "c", ops: [{ edit: "add_node" }] }, scope);
  assert.ok(plain);
  assert.doesNotMatch(plain.title, /delete/i);

  const destructive = classifyToolCall("edit_chart", { chartId: "c", ops: [{ edit: "delete_node" }] }, scope);
  assert.ok(destructive);
  assert.match(destructive.title, /deletes cards/);
  assert.match(destructive.detail!, /1 card deleted/);
});
