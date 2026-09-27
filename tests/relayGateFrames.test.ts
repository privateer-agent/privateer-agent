/**
 * The two relay frames that lower the permission gate — `approval_response` and
 * `no_quarter` — must carry the account's signature before they can widen anything.
 *
 * The relay is untrusted (docs/harbor-channels-and-app.md §6). Before this, a hostile
 * relay could send `{type:"no_quarter",on:true}` and lift the gate for the whole
 * session (plan mode included, since the flag is ModeGate's first check), or answer a
 * pending approval it had just carried up with an unsigned "allow". These tests drive
 * RelayClient.handle with raw frames, as the relay would.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

const HOME = mkdtempSync(join(tmpdir(), "privateer-gate-frames-"));
process.env.PRIVATEER_HOME = HOME;

const { RelayClient } = await import("../src/remote/relayClient.ts");
const { RemoteBridge } = await import("../src/remote/remoteBridge.ts");
const { pinAccountSignKey, clearAccountSignKey } = await import("../src/crypto/accountTrust.ts");
const { noQuarterActive, setNoQuarter } = await import("../src/permissions/noQuarter.ts");

// Inline replica of the app signer (treeview/client/services/accountSign.ts signControl).
const enc = new TextEncoder();
const KDF_SIGN = enc.encode("privateer-account-sign-v1");
const SIGN_SALT = sha256(enc.encode("privateer-account-sign-salt"));
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}
function seed(mk: Uint8Array) { return hkdf(sha256, mk, SIGN_SALT, KDF_SIGN, 32); }
function pub(mk: Uint8Array) { return Buffer.from(ed25519.getPublicKey(seed(mk))).toString("base64"); }
function sign(mk: Uint8Array, env: { termId: string; ts: number; action: string; args: Record<string, unknown> }) {
  const msg = enc.encode("privateer-control-v1" + canonicalize({ action: env.action, args: env.args, termId: env.termId, ts: env.ts }));
  return Buffer.from(ed25519.sign(msg, seed(mk))).toString("base64");
}

const MK = sha256(enc.encode("test-master-key"));
const OTHER_MK = sha256(enc.encode("someone-else"));
let clock = 1_800_000_000_000;
const nextTs = () => ++clock;

test.after(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });
test.beforeEach(() => {
  setNoQuarter(false);
  pinAccountSignKey(pub(MK));
});

// A bridge on a RelayClient whose socket is a recorder. `feed` is the relay's side.
function harness(termId = `term-${randomTag()}`) {
  const bridge = new RemoteBridge({ onPrompt: () => {} });
  const relay: any = new RelayClient(bridge.callbacks, { termId, label: "t" });
  const sent: any[] = [];
  relay.ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)) };
  bridge.attachRelay(relay);
  const feed = (frame: Record<string, unknown>) => relay.handle(Buffer.from(JSON.stringify(frame)));
  return { bridge, relay, sent, feed, termId };
}
function randomTag() { return Math.random().toString(36).slice(2, 8); }

// Start an ask and hand back its id (as the relay saw it) and its outcome.
async function pendingAsk(h: ReturnType<typeof harness>) {
  const outcome = h.bridge.remoteAsk({ tool: "bash", kind: "bash", title: "Run", detail: "rm -rf build" });
  const req = h.sent.find((f) => f.type === "approval_request");
  assert.ok(req, "the ask went up to the relay");
  return { id: req.id as string, outcome };
}

// ── no_quarter ─────────────────────────────────────────────────────────────────

test("an unsigned no_quarter on is refused, and the app is told the real state", () => {
  const h = harness();
  h.feed({ type: "no_quarter", on: true });
  assert.equal(noQuarterActive(), false);
  assert.equal(h.bridge.getNoQuarter(), false);
  assert.ok(h.sent.some((f) => f.type === "no_quarter" && f.on === false), "echoes the flag is still down");
  assert.ok(h.sent.some((f) => f.type === "notice"), "says why");
});

test("a signed no_quarter on is applied", () => {
  const h = harness();
  const ts = nextTs();
  h.feed({ type: "no_quarter", on: true, ts, sig: sign(MK, { termId: h.termId, ts, action: "no_quarter", args: { on: true } }) });
  assert.equal(noQuarterActive(), true);
});

test("no_quarter signed by another account, or for another terminal, is refused", () => {
  const h = harness();
  let ts = nextTs();
  h.feed({ type: "no_quarter", on: true, ts, sig: sign(OTHER_MK, { termId: h.termId, ts, action: "no_quarter", args: { on: true } }) });
  assert.equal(noQuarterActive(), false, "wrong key");
  ts = nextTs();
  h.feed({ type: "no_quarter", on: true, ts, sig: sign(MK, { termId: "someone-else", ts, action: "no_quarter", args: { on: true } }) });
  assert.equal(noQuarterActive(), false, "wrong terminal");
});

test("a replayed no_quarter on is refused after the user turned it off", () => {
  const h = harness();
  const ts = nextTs();
  const frame = { type: "no_quarter", on: true, ts, sig: sign(MK, { termId: h.termId, ts, action: "no_quarter", args: { on: true } }) };
  h.feed(frame);
  assert.equal(noQuarterActive(), true);
  h.feed({ type: "no_quarter", on: false });
  assert.equal(noQuarterActive(), false, "lowering needs no signature");
  h.feed(frame);
  assert.equal(noQuarterActive(), false, "the captured frame can't raise it again");
});

test("with no pinned account key, no_quarter on fails closed", () => {
  clearAccountSignKey();
  const h = harness();
  const ts = nextTs();
  h.feed({ type: "no_quarter", on: true, ts, sig: sign(MK, { termId: h.termId, ts, action: "no_quarter", args: { on: true } }) });
  assert.equal(noQuarterActive(), false);
});

// ── approval_response ──────────────────────────────────────────────────────────

test("an unsigned allow is refused and the ask settles as deny", async () => {
  const h = harness();
  const { id, outcome } = await pendingAsk(h);
  h.feed({ type: "approval_response", id, decision: "allow" });
  assert.equal(await outcome, "deny");
});

test("a signed allow for that exact request is accepted", async () => {
  const h = harness();
  const { id, outcome } = await pendingAsk(h);
  const ts = nextTs();
  h.feed({
    type: "approval_response", id, decision: "allow", ts,
    sig: sign(MK, { termId: h.termId, ts, action: "approval_response", args: { id, decision: "allow" } }),
  });
  assert.equal(await outcome, "allow");
});

test("a signed allow for a different request id does not transfer", async () => {
  const h = harness();
  const { id, outcome } = await pendingAsk(h);
  const ts = nextTs();
  h.feed({
    type: "approval_response", id, decision: "allow", ts,
    sig: sign(MK, { termId: h.termId, ts, action: "approval_response", args: { id: "some-earlier-id", decision: "allow" } }),
  });
  assert.equal(await outcome, "deny");
});

test("a missing or unknown decision is a deny, not an allow", async () => {
  for (const decision of [undefined, "always", "ALLOW", ""]) {
    const h = harness();
    const { id, outcome } = await pendingAsk(h);
    h.feed({ type: "approval_response", id, decision });
    assert.equal(await outcome, "deny", `decision=${String(decision)}`);
  }
});

test("an unsigned deny still works (refusing is safe from anyone)", async () => {
  const h = harness();
  const { id, outcome } = await pendingAsk(h);
  h.feed({ type: "approval_response", id, decision: "deny" });
  assert.equal(await outcome, "deny");
});

test("several signed allows in the same millisecond are all accepted", async () => {
  const h = harness();
  const a = await pendingAsk(h);
  h.sent.length = 0;
  const b = await pendingAsk(h);
  const ts = nextTs();
  for (const { id } of [a, b]) {
    h.feed({
      type: "approval_response", id, decision: "allow", ts,
      sig: sign(MK, { termId: h.termId, ts, action: "approval_response", args: { id, decision: "allow" } }),
    });
  }
  assert.equal(await a.outcome, "allow");
  assert.equal(await b.outcome, "allow");
});
