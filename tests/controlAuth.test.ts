import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

// Isolate every run in a throwaway PRIVATEER_HOME so the pin + watermark files don't
// touch the real ~/.privateer. Set BEFORE importing modules that read globalDir().
const HOME = mkdtempSync(join(tmpdir(), "privateer-ctrl-"));
process.env.PRIVATEER_HOME = HOME;

const { authorizeControl } = await import("../src/remote/controlAuth.ts");
const { pinAccountSignKey, clearAccountSignKey } = await import("../src/crypto/accountTrust.ts");

// Inline replica of the app signer (accountSign.ts).
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
const TERM = "routines-abc";
const args = { source: "npm:some-pkg" };

test.after(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

test("authorizeControl: fail-closed with no pinned account key", () => {
  clearAccountSignKey();
  const ts = 1_752_000_000_000;
  const r = authorizeControl(TERM, "extensions_add", args, sign(MK, { termId: TERM, ts, action: "extensions_add", args }), ts);
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /re-link/i);
});

test("authorizeControl: accepts a valid signed frame once the account key is pinned", () => {
  pinAccountSignKey(pub(MK));
  const ts = 1_752_000_100_000;
  const r = authorizeControl(TERM, "extensions_add", args, sign(MK, { termId: TERM, ts, action: "extensions_add", args }), ts);
  assert.equal(r.ok, true);
});

test("authorizeControl: refuses an unsigned frame (no sig / no ts)", () => {
  pinAccountSignKey(pub(MK));
  assert.equal(authorizeControl(TERM, "extensions_add", args, undefined, 1_752_000_200_000).ok, false);
  assert.equal(authorizeControl(TERM, "extensions_add", args, "c2ln", undefined).ok, false);
});

test("authorizeControl: refuses a forged frame (valid sig, tampered args)", () => {
  pinAccountSignKey(pub(MK));
  const ts = 1_752_000_300_000;
  const sig = sign(MK, { termId: TERM, ts, action: "extensions_add", args });
  const r = authorizeControl(TERM, "extensions_add", { source: "npm:evil-pkg" }, sig, ts);
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /verify/i);
});

test("authorizeControl: rejects a replay (ts at/below the watermark)", () => {
  pinAccountSignKey(pub(MK));
  const ts = 1_752_000_400_000;
  const mk = MK;
  const first = authorizeControl(TERM, "extensions_add", args, sign(mk, { termId: TERM, ts, action: "extensions_add", args }), ts);
  assert.equal(first.ok, true);
  // Same (or older) ts replayed → refused now that the watermark advanced.
  const replay = authorizeControl(TERM, "extensions_add", args, sign(mk, { termId: TERM, ts: ts - 1, action: "extensions_add", args }), ts - 1);
  assert.equal(replay.ok, false);
  assert.match(replay.message ?? "", /out-of-date/i);
});

test("authorizeControl: watermark is per-terminal (a different termId is independent)", () => {
  pinAccountSignKey(pub(MK));
  // TERM's watermark is high from the prior test; a fresh terminal with a small ts is
  // still accepted because the watermark is keyed by termId.
  const otherTerm = "terminal-fresh";
  const ts = 1_000_000; // far below TERM's watermark
  const r = authorizeControl(otherTerm, "skills_delete", { name: "x" }, sign(MK, { termId: otherTerm, ts, action: "skills_delete", args: { name: "x" } }), ts);
  assert.equal(r.ok, true);
});
