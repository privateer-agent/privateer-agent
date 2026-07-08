/**
 * Outbox sealed-box crypto — SENDER (terminal) side.
 *
 * A running terminal seals summaries of unattended results (completed routines,
 * finished agent tasks) to the account's outbox public key and POSTs the
 * ciphertext to the server, so the app can catch up on next open without any
 * push notification.
 *
 * This terminal holds NO account key material. By design this module can ONLY
 * seal — there is no `open` and no way to derive the account private key here.
 * A stolen terminal can post messages but can never read the outbox, other
 * terminals' results, or any history. That "write-only terminal" property is
 * the whole reason the outbox is asymmetric rather than symmetric.
 *
 * Construction and domain-separation constants MUST stay byte-for-byte in sync
 * with treeview/client/services/outboxSeal.ts (the recipient side):
 *   X25519 → HKDF-SHA256 → AES-256-GCM. Wire: epk(32) ‖ iv(12) ‖ ct‖tag, base64.
 */

import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/hashes/utils";

const enc = new TextEncoder();

// MUST match treeview/client/services/outboxSeal.ts.
const KDF_SEAL = enc.encode("privateer-outbox-seal-v1");

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

/** Decode the account public key the server hands us (base64 → 32 raw bytes). */
export function decodeAccountPublicKey(b64: string): Uint8Array {
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== 32) throw new Error("outbox public key must be 32 bytes");
  return new Uint8Array(buf);
}

/** Seal plaintext to the account public key. Returns the base64 wire string. */
export function seal(accountPub: Uint8Array, plaintext: Uint8Array): string {
  const esk = x25519.utils.randomPrivateKey();
  const epk = x25519.getPublicKey(esk);
  const shared = x25519.getSharedSecret(esk, accountPub);
  const salt = concat(epk, accountPub);          // binds ephemeral + recipient
  const key = hkdf(sha256, shared, salt, KDF_SEAL, 32);
  const iv = randomBytes(12);
  const ct = gcm(key, iv).encrypt(plaintext);    // ct includes the 16-byte tag
  return Buffer.from(concat(epk, iv, ct)).toString("base64");
}

/** Seal a JSON-serializable value. */
export function sealJson(accountPub: Uint8Array, obj: unknown): string {
  return seal(accountPub, enc.encode(JSON.stringify(obj)));
}
