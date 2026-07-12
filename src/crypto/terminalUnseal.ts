/**
 * App→terminal sealed-box crypto — RECIPIENT (terminal) side.
 *
 * The inverse of the outbox: here the APP is the sender and this terminal is the
 * recipient. The app seals a secret (a channel bot token) to this terminal's pinned
 * public key (see terminalKey.ts); only this terminal — holder of the matching
 * private key — can open it. The server forwards the ciphertext over the relay and
 * cannot read it, which is the whole point of Phase 3.
 *
 * Construction MUST stay byte-for-byte in sync with the sender:
 *   treeview/client/services/terminalSeal.ts
 *   X25519 → HKDF-SHA256 → AES-256-GCM. Wire: epk(32) ‖ iv(12) ‖ ct‖tag, base64.
 *   salt = epk ‖ recipientPub ; HKDF info = "privateer-channel-seal-v1".
 *
 * Domain separation: the "channel-seal" HKDF label is DISTINCT from the outbox's
 * "privateer-outbox-seal-v1", so a blob from one protocol can never be opened as the
 * other even though both are X25519 sealed boxes to the same curve.
 */

import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes.js";
import { terminalSecretKey } from "./terminalKey.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

// MUST match treeview/client/services/terminalSeal.ts.
const KDF_SEAL = enc.encode("privateer-channel-seal-v1");

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Open a base64 wire string the app sealed to THIS terminal's public key. Returns the
 * plaintext bytes; throws on tamper, a wrong recipient, or a malformed blob (the GCM
 * tag check is the integrity guarantee). Uses this terminal's private key — which
 * never leaves the 0600 key file.
 */
export function openFromApp(wireB64: string): Uint8Array {
  const sk = terminalSecretKey();
  const recipientPub = x25519.getPublicKey(sk);
  const wire = new Uint8Array(Buffer.from(wireB64, "base64"));
  if (wire.length < 32 + 12 + 16) throw new Error("sealed blob too short");
  const epk = wire.subarray(0, 32);
  const iv = wire.subarray(32, 44);
  const ct = wire.subarray(44);
  const shared = x25519.getSharedSecret(sk, epk);
  const salt = concat(epk, recipientPub); // binds ephemeral + this recipient
  const key = hkdf(sha256, shared, salt, KDF_SEAL, 32);
  return gcm(key, iv).decrypt(ct); // throws if the tag doesn't verify
}

/** Open + JSON-parse. Throws on tamper/wrong-key/invalid JSON. */
export function openJsonFromApp<T = unknown>(wireB64: string): T {
  return JSON.parse(dec.decode(openFromApp(wireB64))) as T;
}
