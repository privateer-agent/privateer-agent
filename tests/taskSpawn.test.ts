import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

// Isolate the pin + watermark files in a throwaway home. Set BEFORE importing modules
// that read globalDir().
const HOME = mkdtempSync(join(tmpdir(), "privateer-task-"));
process.env.PRIVATEER_HOME = HOME;

const { authorizeControl } = await import("../src/remote/controlAuth.ts");
const { pinAccountSignKey, clearAccountSignKey } = await import("../src/crypto/accountTrust.ts");
const { taskControlArgs, deriveTaskTitle } = await import("../src/harbor/index.ts");
const { parseTaskSpec, RelayClient } = await import("../src/remote/relayClient.ts");
const { addPendingCloud, loadPendingCloud, savePendingCloud } = await import("../src/routines/store.ts");

// Inline replica of the app signer (client/services/accountSign.ts) — the same one
// controlAuth.test.ts uses. Kept here so a drift in the canonical message construction
// (the thing that gates a spawn = RCE) fails this test loudly.
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
const TERM = "routines-task-test";

test.after(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

test("taskControlArgs: normalizes absent fields to null (fixed key set for signing)", () => {
  assert.deepEqual(taskControlArgs({ prompt: "do a thing" }), {
    prompt: "do a thing",
    cwd: null,
    model: null,
    tools: null,
    title: null,
  });
  assert.deepEqual(taskControlArgs({ prompt: "p", cwd: "/w", model: "privateer/x", tools: ["read"], title: "T" }), {
    prompt: "p",
    cwd: "/w",
    model: "privateer/x",
    tools: ["read"],
    title: "T",
  });
});

test("task_submit: a correctly-signed frame passes the RCE gate", () => {
  pinAccountSignKey(pub(MK));
  const spec = { prompt: "summarize the repo", title: "summary" };
  const args = taskControlArgs(spec);
  const ts = 1_752_100_000_000;
  const r = authorizeControl(TERM, "task_submit", args, sign(MK, { termId: TERM, ts, action: "task_submit", args }), ts);
  assert.equal(r.ok, true);
});

test("task_submit: a forged frame (tampered prompt) is refused", () => {
  pinAccountSignKey(pub(MK));
  const signedSpec = { prompt: "read the readme" };
  const ts = 1_752_100_100_000;
  const sig = sign(MK, { termId: TERM, ts, action: "task_submit", args: taskControlArgs(signedSpec) });
  // Attacker swaps the prompt to something malicious after signing.
  const forged = taskControlArgs({ prompt: "rm -rf / via bash" });
  const r = authorizeControl(TERM, "task_submit", forged, sig, ts);
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /verify/i);
});

test("task_submit: an unsigned frame is refused (fail-closed)", () => {
  pinAccountSignKey(pub(MK));
  const args = taskControlArgs({ prompt: "anything" });
  assert.equal(authorizeControl(TERM, "task_submit", args, undefined, 1_752_100_200_000).ok, false);
});

test("task_spawn: shares the same signed-args gate as task_submit", () => {
  pinAccountSignKey(pub(MK));
  const spec = { prompt: "help me refactor", title: "refactor", cwd: "/repo" };
  const args = taskControlArgs(spec);
  const ts = 1_752_100_300_000;
  const good = authorizeControl(TERM, "task_spawn", args, sign(MK, { termId: TERM, ts, action: "task_spawn", args }), ts);
  assert.equal(good.ok, true);
  // A signature made for task_submit must NOT authorize a task_spawn (action binds).
  const ts2 = 1_752_100_400_000;
  const crossSig = sign(MK, { termId: TERM, ts: ts2, action: "task_submit", args });
  assert.equal(authorizeControl(TERM, "task_spawn", args, crossSig, ts2).ok, false);
});

test("parseTaskSpec: keeps only well-typed fields (absent/mistyped dropped)", () => {
  assert.deepEqual(parseTaskSpec({ prompt: "p" }), { prompt: "p" });
  assert.deepEqual(
    parseTaskSpec({ prompt: "p", cwd: "/w", model: "m", title: "t", tools: ["read", "grep"] }),
    { prompt: "p", cwd: "/w", model: "m", title: "t", tools: ["read", "grep"] },
  );
  // A mistyped tools (not an array of strings) is dropped, not passed through.
  assert.deepEqual(parseTaskSpec({ prompt: "p", tools: ["read", 3] as unknown as string[] }), { prompt: "p" });
  // A frame the parser must round-trip through taskControlArgs identically to what the
  // app signed (prompt-only case).
  const spec = parseTaskSpec({ prompt: "only prompt" });
  assert.deepEqual(taskControlArgs(spec), { prompt: "only prompt", cwd: null, model: null, tools: null, title: null });
});

test("deriveTaskTitle: explicit title wins, else first non-empty prompt line, clipped", () => {
  assert.equal(deriveTaskTitle({ prompt: "x", title: "  My Task  " }), "My Task");
  assert.equal(deriveTaskTitle({ prompt: "\n\n  first line\nsecond" }), "first line");
  assert.equal(deriveTaskTitle({ prompt: "a".repeat(200) }).length, 80);
});

test("task frames are strict: an equal-ts replay is refused (non-idempotent RCE)", () => {
  pinAccountSignKey(pub(MK));
  const spec = { prompt: "run me once" };
  const args = taskControlArgs(spec);
  const ts = 1_752_100_600_000;
  const sig = sign(MK, { termId: TERM, ts, action: "task_submit", args });
  // First delivery accepted (advances the watermark to ts).
  assert.equal(authorizeControl(TERM, "task_submit", args, sig, ts, { strict: true }).ok, true);
  // A malicious relay replays the SAME signed frame — strict refuses the equal ts, so the
  // task does NOT run a second time.
  const replay = authorizeControl(TERM, "task_submit", args, sig, ts, { strict: true });
  assert.equal(replay.ok, false);
  assert.match(replay.message ?? "", /out-of-date/i);
});

test("non-strict (idempotent config) still accepts an equal-ts replay by design", () => {
  pinAccountSignKey(pub(MK));
  const args = { idOrName: "job" };
  const ts = 1_752_100_700_000;
  const sig = sign(MK, { termId: TERM, ts, action: "routines_set_enabled", args });
  assert.equal(authorizeControl(TERM, "routines_set_enabled", args, sig, ts).ok, true);
  // Same ts re-applies the same config — harmless, so the default path accepts it.
  assert.equal(authorizeControl(TERM, "routines_set_enabled", args, sig, ts).ok, true);
});

test("pending-cloud queue preserves kind so a deferred task re-seals as a task", () => {
  savePendingCloud([]);
  addPendingCloud({ routine: "a routine", at: "2026-07-13T00:00:00Z", status: "ok", content: "r" });
  addPendingCloud({ routine: "a task", at: "2026-07-13T00:01:00Z", status: "error", content: "t", kind: "task" });
  const q = loadPendingCloud();
  assert.equal(q.length, 2);
  assert.equal(q[0].kind, undefined); // legacy/back-compat → treated as routine on flush
  assert.equal(q[1].kind, "task");
  savePendingCloud([]);
});

// Sanity: clearing the pin makes even a valid signature fail (re-link required).
test("task gate: no pinned account key ⇒ refused", () => {
  clearAccountSignKey();
  const spec = { prompt: "p" };
  const args = taskControlArgs(spec);
  const ts = 1_752_100_500_000;
  const r = authorizeControl(TERM, "task_submit", args, sign(MK, { termId: TERM, ts, action: "task_submit", args }), ts);
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /re-link/i);
});

// A live spawn only announces `task_spawned` after the child terminal actually registers on
// the relay. awaitRegistered() is that gate: with no relay reachable it must REJECT (not hang)
// so spawnLiveTask reports task_spawn_error instead of pointing the app at a dead terminal.
test("relay awaitRegistered rejects on timeout when the terminal never registers", async () => {
  const relay = new RelayClient({} as any, { termId: "task-never", label: "t" });
  await assert.rejects(relay.awaitRegistered(50), /timed out/i);
});
