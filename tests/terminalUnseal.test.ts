import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/hashes/utils";
import { terminalPublicKeyBase64 } from "../src/crypto/terminalKey.ts";
import { openFromApp, openJsonFromApp } from "../src/crypto/terminalUnseal.ts";

// One isolated PRIVATEER_HOME for the whole file (terminalKey caches per process).
const home = mkdtempSync(join(tmpdir(), "priv-home-"));
process.env.PRIVATEER_HOME = home;

const enc = new TextEncoder();
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// A byte-for-byte replica of treeview/client/services/terminalSeal.ts (the SENDER).
// If this opens with the agent's openFromApp, the two sides are wire-compatible.
function clientSeal(pubB64: string, plaintext: Uint8Array, label = "privateer-channel-seal-v1"): string {
  const recipientPub = new Uint8Array(Buffer.from(pubB64, "base64"));
  const esk = x25519.utils.randomPrivateKey();
  const epk = x25519.getPublicKey(esk);
  const shared = x25519.getSharedSecret(esk, recipientPub);
  const salt = concat(epk, recipientPub);
  const key = hkdf(sha256, shared, salt, enc.encode(label), 32);
  const iv = randomBytes(12);
  const ct = gcm(key, iv).encrypt(plaintext);
  return Buffer.from(concat(concat(epk, iv), ct)).toString("base64");
}

test("terminalUnseal: opens a blob sealed with the client construction (byte-compat)", () => {
  const pub = terminalPublicKeyBase64();
  const msg = enc.encode("bot-token-12345:very-secret");
  const wire = clientSeal(pub, msg);
  assert.deepEqual(openFromApp(wire), msg);
});

test("terminalUnseal: JSON round-trips (the channel-secrets envelope shape)", () => {
  const pub = terminalPublicKeyBase64();
  const payload = { termId: "routines-abc", secrets: { botToken: "s3cr3t" } };
  const wire = clientSeal(pub, enc.encode(JSON.stringify(payload)));
  assert.deepEqual(openJsonFromApp(wire), payload);
});

test("terminalUnseal: a tampered ciphertext fails the GCM tag", () => {
  const pub = terminalPublicKeyBase64();
  const wire = clientSeal(pub, enc.encode("secret"));
  const bytes = Buffer.from(wire, "base64");
  bytes[bytes.length - 1] ^= 0x01; // flip a tag byte
  assert.throws(() => openFromApp(bytes.toString("base64")));
});

test("terminalUnseal: a blob sealed to a DIFFERENT key does not open", () => {
  // Seal to an unrelated pubkey → our secret key can't derive the same shared secret.
  const otherPub = Buffer.from(x25519.getPublicKey(x25519.utils.randomPrivateKey())).toString("base64");
  const wire = clientSeal(otherPub, enc.encode("secret"));
  assert.throws(() => openFromApp(wire));
});

test("terminalUnseal: a wrong-domain (outbox-label) blob does not open as a channel seal", () => {
  const pub = terminalPublicKeyBase64();
  const wire = clientSeal(pub, enc.encode("secret"), "privateer-outbox-seal-v1");
  assert.throws(() => openFromApp(wire)); // different HKDF info → different AES key
});

test("terminalUnseal: rejects a truncated blob", () => {
  assert.throws(() => openFromApp(Buffer.from("short").toString("base64")));
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
