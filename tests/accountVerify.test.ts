import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { verifyChannelSave, type ChannelSaveEnvelope } from "../src/crypto/accountVerify.ts";

// ── Inline replica of treeview/client/services/accountSign.ts (the SIGNER). If the
// agent's verifyChannelSave accepts a signature produced here, the two files' key
// derivation + canonical message construction agree byte-for-byte. ────────────────
const enc = new TextEncoder();
const KDF_SIGN = enc.encode("privateer-account-sign-v1");
const SIGN_SALT = sha256(enc.encode("privateer-account-sign-salt"));

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}
function clientMessage(env: ChannelSaveEnvelope): Uint8Array {
  return enc.encode(
    "privateer-channel-cfg-v1" +
      canonicalize({ termId: env.termId, ts: env.ts, draft: env.draft, sealedSecrets: env.sealedSecrets ?? null }),
  );
}
function clientSeed(masterKey: Uint8Array): Uint8Array {
  return hkdf(sha256, masterKey, SIGN_SALT, KDF_SIGN, 32);
}
function clientPub(masterKey: Uint8Array): string {
  return Buffer.from(ed25519.getPublicKey(clientSeed(masterKey))).toString("base64");
}
function clientSign(masterKey: Uint8Array, env: ChannelSaveEnvelope): string {
  return Buffer.from(ed25519.sign(clientMessage(env), clientSeed(masterKey))).toString("base64");
}

const MK = sha256(enc.encode("test-master-key")); // a deterministic 32-byte "master key"
const env: ChannelSaveEnvelope = {
  termId: "routines-abc",
  ts: 1_752_000_000_000,
  draft: { platform: "telegram", admins: ["111", "222"], posture: "approve" },
  sealedSecrets: "c2VhbGVk",
};

test("accountVerify: accepts a signature produced by the client construction", () => {
  assert.equal(verifyChannelSave(clientPub(MK), env, clientSign(MK, env)), true);
});

test("accountVerify: key order in the draft does not affect verification (canonical)", () => {
  const reordered: ChannelSaveEnvelope = {
    ...env,
    draft: { posture: "approve", admins: ["111", "222"], platform: "telegram" }, // same fields, different order
  };
  // Signature made over the reordered object still verifies against the original,
  // because canonicalize sorts keys.
  assert.equal(verifyChannelSave(clientPub(MK), env, clientSign(MK, reordered)), true);
});

test("accountVerify: rejects a tampered admin list (F8 — injected admin)", () => {
  const sig = clientSign(MK, env);
  const tampered: ChannelSaveEnvelope = { ...env, draft: { ...env.draft, admins: ["attacker"] } };
  assert.equal(verifyChannelSave(clientPub(MK), tampered, sig), false);
});

test("accountVerify: rejects a swapped sealed-secrets blob (F7 — forged token)", () => {
  const sig = clientSign(MK, env);
  const forged: ChannelSaveEnvelope = { ...env, sealedSecrets: "b3RoZXI" };
  assert.equal(verifyChannelSave(clientPub(MK), forged, sig), false);
});

test("accountVerify: rejects a different termId (misroute) and a changed ts (replay)", () => {
  const sig = clientSign(MK, env);
  assert.equal(verifyChannelSave(clientPub(MK), { ...env, termId: "routines-other" }, sig), false);
  assert.equal(verifyChannelSave(clientPub(MK), { ...env, ts: env.ts + 1 }, sig), false);
});

test("accountVerify: rejects a signature from a different account key", () => {
  const otherMk = sha256(enc.encode("someone-else"));
  assert.equal(verifyChannelSave(clientPub(MK), env, clientSign(otherMk, env)), false);
});

test("accountVerify: returns false (no throw) on malformed key/sig", () => {
  assert.equal(verifyChannelSave("!!notb64!!", env, clientSign(MK, env)), false);
  assert.equal(verifyChannelSave(clientPub(MK), env, "!!notb64!!"), false);
  assert.equal(verifyChannelSave("", env, ""), false);
});
