import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x25519 } from "@noble/curves/ed25519";
import { terminalPublicKeyBase64, terminalSecretKey } from "../src/crypto/terminalKey.ts";

// terminalKey caches the loaded keypair for the process lifetime, so all assertions
// share ONE isolated PRIVATEER_HOME set before the first call.
const home = mkdtempSync(join(tmpdir(), "priv-home-"));
process.env.PRIVATEER_HOME = home;

test("terminalKey: mints a valid 32-byte X25519 keypair and persists it 0600", () => {
  const pubB64 = terminalPublicKeyBase64();
  const pub = Buffer.from(pubB64, "base64");
  assert.equal(pub.length, 32, "public key is 32 raw bytes");

  // The file exists, is well-formed, and (on POSIX) owner-only.
  const raw = readFileSync(join(home, "terminal-key.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.publicKey, pubB64);
  assert.ok(typeof parsed.secretKey === "string");
  if (process.platform !== "win32") {
    const mode = statSync(join(home, "terminal-key.json")).mode & 0o777;
    assert.equal(mode, 0o600, "key file is owner read/write only");
  }
});

test("terminalKey: public key matches the secret key, and both are stable", () => {
  const pubB64 = terminalPublicKeyBase64();
  const sk = terminalSecretKey();
  const derived = Buffer.from(x25519.getPublicKey(sk)).toString("base64");
  assert.equal(derived, pubB64, "getPublicKey(secret) === advertised public key");
  // Cached → identical on every call (no regeneration, no drift).
  assert.equal(terminalPublicKeyBase64(), pubB64);
});

test("terminalKey: the keypair round-trips an X25519 shared secret (seal↔open basis)", () => {
  // Prove the pinned pub + local secret can agree a shared secret with an ephemeral
  // sender — the exact primitive Phase 3's app-seal / terminal-open is built on.
  const pub = new Uint8Array(Buffer.from(terminalPublicKeyBase64(), "base64"));
  const sk = terminalSecretKey();
  const esk = x25519.utils.randomPrivateKey();
  const epk = x25519.getPublicKey(esk);
  const senderShared = x25519.getSharedSecret(esk, pub); // app side (seal)
  const recipientShared = x25519.getSharedSecret(sk, epk); // terminal side (open)
  assert.deepEqual(recipientShared, senderShared);
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
