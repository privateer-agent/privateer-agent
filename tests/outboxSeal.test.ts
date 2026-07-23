import { test } from "node:test";
import assert from "node:assert/strict";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes.js";
import { sealJson, decodeAccountPublicKey } from "../src/crypto/outboxSeal.ts";

// Recipient (key-holding client) side, replicated here so the CLI's write-only
// seal path can be round-tripped in isolation. MUST match the construction in
// treeview/client/services/outboxSeal.ts — this test is the interop guard.
const enc = new TextEncoder();
const dec = new TextDecoder();
const ACCOUNT_SALT = sha256(enc.encode("privateer-outbox-account-salt"));
const KDF_ACCOUNT = enc.encode("privateer-outbox-x25519-v1");
const KDF_SEAL = enc.encode("privateer-outbox-seal-v1");

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

function deriveSecretKey(masterKey: Uint8Array): Uint8Array {
  return hkdf(sha256, masterKey, ACCOUNT_SALT, KDF_ACCOUNT, 32);
}

function openJson<T>(masterKey: Uint8Array, wireB64: string): T {
  const sk = deriveSecretKey(masterKey);
  const pub = x25519.getPublicKey(sk);
  const wire = new Uint8Array(Buffer.from(wireB64, "base64"));
  const epk = wire.subarray(0, 32);
  const iv = wire.subarray(32, 44);
  const ct = wire.subarray(44);
  const shared = x25519.getSharedSecret(sk, epk);
  const key = hkdf(sha256, shared, concat(epk, pub), KDF_SEAL, 32);
  return JSON.parse(dec.decode(gcm(key, iv).decrypt(ct))) as T;
}

// A deterministic 32-byte "master key" stand-in for the account vault key.
const MASTER = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
const PUB = x25519.getPublicKey(deriveSecretKey(MASTER));

test("outbox: CLI-sealed envelope opens on the recipient side", () => {
  const envelope = { v: 1, kind: "routine", name: "morning brief", status: "ok", at: "2026-07-07T08:00:00Z", content: "# Result\nAll good." };
  const wire = sealJson(PUB, envelope);
  const opened = openJson<typeof envelope>(MASTER, wire);
  assert.deepEqual(opened, envelope);
});

test("outbox: decodeAccountPublicKey round-trips a 32-byte key and rejects bad lengths", () => {
  const b64 = Buffer.from(PUB).toString("base64");
  assert.deepEqual(decodeAccountPublicKey(b64), PUB);
  assert.throws(() => decodeAccountPublicKey(Buffer.from(new Uint8Array(31)).toString("base64")));
});

test("outbox: a max-size body seals to base64 under the server cap", () => {
  // The harbor caps plaintext at 45_000 chars before sealing; the server rejects
  // sealed base64 over 128 KiB. Confirm the worst case stays comfortably under.
  const body = "x".repeat(45_000) + "\n…truncated";
  const wire = sealJson(PUB, { v: 1, kind: "routine", name: "big", status: "ok", at: "2026-07-07T08:00:00Z", content: body });
  assert.ok(wire.length < 128 * 1024, `sealed base64 ${wire.length} must be under 128KiB`);
});

test("outbox: a tampered ciphertext fails to open", () => {
  const wire = sealJson(PUB, { hello: "world" });
  const bytes = Buffer.from(wire, "base64");
  bytes[bytes.length - 1] ^= 0xff; // flip a tag byte
  assert.throws(() => openJson(MASTER, bytes.toString("base64")));
});
