import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteBridge, type RelayLike } from "../src/remote/remoteBridge.ts";
import { makeSaveCargoTool } from "../src/tools/cargo.ts";
import { classifyToolCall } from "../src/permissions/classify.ts";
import { MAX_CARGO_BYTES, kindForExtension } from "../src/remote/cargoSave.ts";
import { queuedCargoEnvelope } from "../src/outbox/cloudOutbox.ts";

// save_cargo is the one tool whose whole point is that the CLI CANNOT do the work
// itself: it holds no master key, so the app has to encrypt. That makes the round trip
// — and every way it can fail without an artifact existing — the thing worth testing.

function makeFakeRelay(opts: { connected?: boolean; controller?: boolean } = {}) {
  let connected = opts.connected ?? true;
  let controller = opts.controller ?? true;
  const cargoSaves: { id: string; req: any }[] = [];
  const relay: RelayLike & { cargoSaves: typeof cargoSaves; setConnected(v: boolean): void } = {
    cargoSaves,
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
    requestCargoSave(id, req) { cargoSaves.push({ id, req }); },
    requestChartOp() {},
    async requestLibrarySave() {},
  };
  return relay;
}

const tick = () => new Promise((r) => setImmediate(r));

function tmpFile(name: string, content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "pv-cargo-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return { dir, path };
}

// ── the round trip ───────────────────────────────────────────────────────────

test("saveCargoRemote relays the artifact and resolves on the app's verdict", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);

  const p = bridge.saveCargoRemote({ content: "<html></html>", kind: "game", title: "Snake" });
  await tick();

  assert.equal(relay.cargoSaves.length, 1);
  const { id, req } = relay.cargoSaves[0];
  assert.equal(req.kind, "game");
  assert.equal(req.title, "Snake");

  // The app answers on the same id — that correlation is the entire protocol.
  bridge.callbacks.onCargoSaved!(id, { ok: true, cargoId: "abc123", title: "Snake", storageType: "cloud" });
  assert.deepEqual(await p, { ok: true, cargoId: "abc123", title: "Snake", storageType: "cloud" });
});

test("a reply on an unknown id is ignored rather than settling someone else's save", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);

  const p = bridge.saveCargoRemote({ content: "x", kind: "md" });
  await tick();
  bridge.callbacks.onCargoSaved!("not-our-id", { ok: false, reason: "nope" });
  await tick();

  let settled = false;
  void p.then(() => (settled = true));
  await tick();
  assert.equal(settled, false, "a stray reply must not resolve a pending save");

  bridge.callbacks.onCargoSaved!(relay.cargoSaves[0].id, { ok: true, cargoId: "c", title: "t", storageType: "local" });
  assert.equal((await p).ok, true);
});

// ── failing without an artifact, and saying which kind of failure it was ─────

test("no attached controller fails fast and says the app must be open", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  bridge.attachRelay(makeFakeRelay({ controller: false }));
  const res = await bridge.saveCargoRemote({ content: "x", kind: "md" });
  assert.equal(res.ok, false);
  // The message has to name the cause; "save failed" gives the model nothing to act on.
  assert.match((res as any).reason, /not attached/);
});

test("no relay at all points at /remote-access rather than blaming the app", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const res = await bridge.saveCargoRemote({ content: "x", kind: "md" });
  assert.equal(res.ok, false);
  assert.match((res as any).reason, /remote access/);
});

test("an abort settles the save instead of leaving the turn waiting", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  bridge.attachRelay(makeFakeRelay());
  const ac = new AbortController();
  const p = bridge.saveCargoRemote({ content: "x", kind: "md" }, ac.signal);
  await tick();
  ac.abort();
  const res = await p;
  assert.equal(res.ok, false);
  assert.match((res as any).reason, /interrupted/);
});

// A disconnect mid-flight is the one failure that must NOT claim the save didn't
// happen: the app may have stored the artifact and lost the socket before replying.
// Reporting a clean failure there is how a user ends up with two copies.
test("a mid-flight disconnect reports the outcome as UNKNOWN, not as a failure", async () => {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay = makeFakeRelay();
  bridge.attachRelay(relay);
  const p = bridge.saveCargoRemote({ content: "x", kind: "md" });
  await tick();

  relay.setConnected(false);
  bridge.callbacks.onDisconnected!();

  const res = await p;
  assert.equal(res.ok, false);
  assert.match((res as any).reason, /may or may not/);
  assert.match((res as any).reason, /check Cargo/);
});

// The deadline exists because nothing else wraps this call — the gate supplies one for
// remoteAsk, but a tool awaiting the app has no such backstop, and an app too old to
// understand cargo_begin simply never answers.
test("a save that never gets an answer times out instead of wedging the turn", async () => {
  process.env.PRIVATEER_CARGO_TIMEOUT_MS = "40";
  // The bridge's timer is unref'd on purpose (an exiting CLI must not linger 60s for a
  // save nobody is going to answer), so it cannot hold the loop open by itself. In a
  // real turn the relay socket does that; here this interval stands in for it.
  const keepAlive = setInterval(() => {}, 5);
  try {
    const bridge = new RemoteBridge({ onPrompt: () => {} });
    bridge.attachRelay(makeFakeRelay());
    const res = await bridge.saveCargoRemote({ content: "x", kind: "md" });
    assert.equal(res.ok, false);
    assert.match((res as any).reason, /did not answer/);
  } finally {
    clearInterval(keepAlive);
    delete process.env.PRIVATEER_CARGO_TIMEOUT_MS;
  }
});

// ── the tool's own refusals (they never reach the app) ───────────────────────

function toolWith(result: any, queued: any = { ok: true, id: "q1" }) {
  const calls: any[] = [];
  const queuedReqs: any[] = [];
  const tool = makeSaveCargoTool(
    { async saveCargoRemote(req) { calls.push(req); return result; } },
    async (req) => { queuedReqs.push(req); return queued; },
  );
  return { tool, calls, queuedReqs };
}

const okResult = { ok: true as const, cargoId: "c1", title: "Report", storageType: "cloud" };

test("infers the kind from the extension and sends the file's content", async () => {
  const { dir, path } = tmpFile("report.md", "# Report\n\nbody");
  try {
    const { tool, calls } = toolWith(okResult);
    const res: any = await tool.execute("t", { path }, undefined, undefined, {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "md");
    assert.equal(calls[0].content, "# Report\n\nbody");
    assert.match(res.content[0].text, /Saved "Report" to Cargo/);
    // The posture line is load-bearing: this is the one path here that IS end-to-end
    // encrypted, and a model that can't tell it from generation will mis-describe both.
    assert.match(res.content[0].text, /encrypted on their device/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an HTML file may be declared a game or a deck, but not a spreadsheet", async () => {
  const { dir, path } = tmpFile("g.html", "<html><body>game</body></html>");
  try {
    const { tool, calls } = toolWith(okResult);
    const ok: any = await tool.execute("t", { path, kind: "game" }, undefined, undefined, {});
    assert.match(ok.content[0].text, /Saved/);
    assert.equal(calls[0].kind, "game");

    const bad: any = await tool.execute("t", { path, kind: "sheet" }, undefined, undefined, {});
    assert.match(bad.content[0].text, /doesn't match \.html/);
    assert.equal(calls.length, 1, "a mismatched kind must not reach the app");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a file type Cargo cannot hold is refused, and points at send_file_to_client", async () => {
  const { dir, path } = tmpFile("mesh.glb", "not really a mesh");
  try {
    const { tool, calls } = toolWith(okResult);
    const res: any = await tool.execute("t", { path }, undefined, undefined, {});
    assert.match(res.content[0].text, /can't be Cargo/);
    assert.match(res.content[0].text, /send_file_to_client/);
    assert.equal(calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an oversized artifact is refused locally, where the message can name the file", async () => {
  const { dir, path } = tmpFile("big.html", "x".repeat(MAX_CARGO_BYTES + 1));
  try {
    const { tool, calls } = toolWith(okResult);
    const res: any = await tool.execute("t", { path }, undefined, undefined, {});
    assert.match(res.content[0].text, /caps at 512 KB/);
    assert.equal(calls.length, 0, "the app must not be asked to store what it would refuse");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the app's refusal reaches the model verbatim", async () => {
  const { dir, path } = tmpFile("a.csv", "a,b\n1,2");
  try {
    const { tool } = toolWith({ ok: false, reason: "the app is locked — unlock it on this device" });
    const res: any = await tool.execute("t", { path }, undefined, undefined, {});
    assert.match(res.content[0].text, /the app is locked — unlock it on this device/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── no app attached: queue it for the app instead of failing ─────────────────
//
// The fix for "save_cargo only works while the app is attached". The rule worth
// pinning is WHICH failures may queue: only "there was nobody to ask". An app that
// refused, timed out or dropped mid-transfer may already have stored the artifact.

test("an unattached terminal queues the artifact and says it is NOT in Cargo yet", async () => {
  const { dir, path } = tmpFile("deck.html", "<html>slides</html>");
  try {
    const bridge = new RemoteBridge({ onPrompt: () => {} });
    bridge.attachRelay(makeFakeRelay({ controller: false }));
    const queued: any[] = [];
    const tool = makeSaveCargoTool(bridge, async (req) => { queued.push(req); return { ok: true, id: "q1" }; });
    const res: any = await tool.execute("t", { path, kind: "slides", title: "Q3 Deck" }, undefined, undefined, {});
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0], { content: "<html>slides</html>", kind: "slides", title: "Q3 Deck" });
    const out = res.content[0].text;
    assert.match(out, /^Queued "Q3 Deck" for Cargo/);
    assert.match(out, /next time the Privateer app opens/);
    assert.match(out, /not there yet/);
    assert.doesNotMatch(out, /^Saved/, "a queued save must never be reported as saved");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("remote access off and a dropped relay both queue too", async () => {
  const { dir, path } = tmpFile("n.md", "# n");
  try {
    for (const attach of [false, true]) {
      const bridge = new RemoteBridge({ onPrompt: () => {} });
      if (attach) bridge.attachRelay(makeFakeRelay({ connected: false }));
      let n = 0;
      const tool = makeSaveCargoTool(bridge, async () => { n++; return { ok: true, id: "q" }; });
      const res: any = await tool.execute("t", { path }, undefined, undefined, {});
      assert.equal(n, 1, attach ? "disconnected relay" : "no relay");
      assert.match(res.content[0].text, /^Queued n\.md for Cargo/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a session with no bridge at all (a harbor run) only ever queues", async () => {
  const { dir, path } = tmpFile("r.csv", "a,b\n1,2");
  try {
    let n = 0;
    const tool = makeSaveCargoTool(undefined, async () => { n++; return { ok: true, id: "q" }; });
    const res: any = await tool.execute("t", { path }, undefined, undefined, {});
    assert.equal(n, 1);
    assert.match(res.content[0].text, /^Queued/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an ATTACHED app's refusal, timeout or lost reply is never queued as well", async () => {
  const { dir, path } = tmpFile("a.md", "# a");
  try {
    for (const reason of [
      "the app is locked — unlock it on this device",
      "the app did not answer within 60s",
      "the connection to the app dropped before it confirmed the save — the artifact may or may not have been stored",
    ]) {
      const { tool, queuedReqs } = toolWith({ ok: false, reason });
      const res: any = await tool.execute("t", { path }, undefined, undefined, {});
      assert.equal(queuedReqs.length, 0, `queued after: ${reason}`);
      assert.match(res.content[0].text, /^Couldn't save/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an attached app that saves it is never queued", async () => {
  const { dir, path } = tmpFile("a.md", "# a");
  try {
    const { tool, queuedReqs } = toolWith(okResult);
    const res: any = await tool.execute("t", { path }, undefined, undefined, {});
    assert.equal(queuedReqs.length, 0);
    assert.match(res.content[0].text, /^Saved/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("when queueing fails too, the model hears both reasons", async () => {
  const { dir, path } = tmpFile("a.md", "# a");
  try {
    const { tool } = toolWith(
      { ok: false, unattached: true, reason: "the Privateer app is not attached to this terminal" },
      { ok: false, reason: "this terminal is not signed in to a Privateer account — run /signin, then save again" },
    );
    const res: any = await tool.execute("t", { path }, undefined, undefined, {});
    const out = res.content[0].text;
    assert.match(out, /not attached/);
    assert.match(out, /run \/signin/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the queued envelope is the shape the app's reader accepts", () => {
  // treeview client/utils/queuedCargoParse.ts requires type 'cargo', a known kind and
  // non-empty string content; it keeps title/at/origin.label. Pinned here so the two
  // sides can't drift silently — a renamed field is an artifact the app drops.
  const env: any = queuedCargoEnvelope(
    { content: "<html></html>", kind: "game", title: "Snake" },
    new Date("2026-10-13T00:00:00.000Z"),
    { id: "term-1", label: "mac-mini" },
  );
  assert.deepEqual(env, {
    v: 1, type: "cargo", kind: "game", title: "Snake", content: "<html></html>",
    at: "2026-10-13T00:00:00.000Z", origin: { id: "term-1", label: "mac-mini" },
  });
  const untitled: any = queuedCargoEnvelope({ content: "# x", kind: "md" }, new Date(0), { id: "a", label: "b" });
  assert.equal("title" in untitled, false, "no title → the app derives one, as for a live save");
});

// ── pure helpers ─────────────────────────────────────────────────────────────

test("kindForExtension maps only what Cargo can actually hold", () => {
  assert.equal(kindForExtension(".html"), "webpage");
  assert.equal(kindForExtension(".HTM"), "webpage");
  assert.equal(kindForExtension(".md"), "md");
  assert.equal(kindForExtension(".csv"), "sheet");
  assert.equal(kindForExtension(".glb"), null);
  assert.equal(kindForExtension(""), null);
});

// ── the permission gate ──────────────────────────────────────────────────────

const scope = { cwd: "/work", extraDirs: [] as string[] };

test("save_cargo classifies as a write, not as an unknown bash-kind call", () => {
  const req = classifyToolCall("save_cargo", { path: "build/deck.html", kind: "slides" }, scope as any);
  assert.equal(req?.kind, "write");
  // The unknown-tool fallback would DENY this in plan/readonly, where "show me this on
  // my phone" is a perfectly reasonable thing to ask.
  assert.match(req!.title, /Cargo/);
  assert.equal(req!.outside, false);
});

test("a source outside the working directory is flagged, so acceptEdits still prompts", () => {
  const req = classifyToolCall("save_cargo", { path: "/elsewhere/notes.md" }, scope as any);
  assert.equal(req?.outside, true);
  assert.equal(req?.path, "/elsewhere/notes.md");
});
