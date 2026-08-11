// NIP-01 event construction, identity and signatures — the whole cryptographic
// core of the Nostr wire format in one dependency-free file.
//
// Nothing here knows about relays, channels, or Buzz. It is pure: same inputs, same
// bytes out, no clock, no I/O. That's what makes the known-answer tests in
// tests/nostr.test.ts meaningful — if serializeEvent drifts by a single character,
// every id in the fixture set stops recomputing.
//
// The primitives come from @noble/curves, already a direct dependency: Nostr signs
// with BIP-340 Schnorr over secp256k1, which is exactly what `schnorr` provides.

import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

// A tag is a positional string array: ["e", <id>, <relay?>, <marker?>].
export type Tag = string[];

// An event before it has an id or a signature. `pubkey` is the 32-byte x-only
// public key as lowercase hex (64 chars) — NOT the 33-byte compressed form.
export interface UnsignedEvent {
  pubkey: string;
  created_at: number; // unix SECONDS, not millis
  kind: number;
  tags: Tag[];
  content: string;
}

export interface NostrEvent extends UnsignedEvent {
  id: string; // 64-char hex — sha256 of serializeEvent()
  sig: string; // 128-char hex — BIP-340 Schnorr over the id bytes
}

/**
 * The NIP-01 serialization an event's id is computed over: a POSITIONAL array, not
 * an object. Field order is fixed by the spec and is not negotiable.
 *
 * NIP-01 mandates escaping only `\n \" \\ \r \t \b \f` and requires no other
 * escaping — which is precisely what JSON.stringify does for ordinary text. The two
 * diverge only on exotic control characters and lone surrogates, where every real
 * implementation follows JSON.stringify anyway. We do the same, deliberately.
 */
export function serializeEvent(u: UnsignedEvent): string {
  return JSON.stringify([0, u.pubkey, u.created_at, u.kind, u.tags, u.content]);
}

/** The event id: sha256 of the canonical serialization, lowercase hex. */
export function eventId(u: UnsignedEvent): string {
  return bytesToHex(sha256(utf8ToBytes(serializeEvent(u))));
}

/**
 * Compute the id and sign it.
 *
 * `auxRand` exists ONLY so tests can reproduce the published BIP-340 vectors —
 * schnorr.sign is randomized by default, so without it a signature is unpredictable
 * (which is correct and desirable in production). Never pass it outside tests.
 */
export function signEvent(u: UnsignedEvent, secretKeyHex: string, auxRand?: Uint8Array): NostrEvent {
  const id = eventId(u);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(secretKeyHex), auxRand));
  return { ...u, id, sig };
}

/**
 * Verify an event in full, fail-closed on anything malformed.
 *
 * BOTH checks matter and the order is deliberate: recompute the id first, so a
 * tampered `content` or `tags` is caught even when the signature over the ORIGINAL
 * id is still perfectly valid. Verifying only the signature would happily accept an
 * event whose body had been swapped out from under its id.
 */
export function verifyEvent(ev: NostrEvent): boolean {
  try {
    if (
      typeof ev?.id !== "string" ||
      typeof ev.sig !== "string" ||
      typeof ev.pubkey !== "string" ||
      typeof ev.content !== "string" ||
      typeof ev.kind !== "number" ||
      typeof ev.created_at !== "number" ||
      !Array.isArray(ev.tags)
    ) {
      return false;
    }
    if (ev.id.length !== 64 || ev.sig.length !== 128 || ev.pubkey.length !== 64) return false;
    if (eventId(ev) !== ev.id) return false;
    return schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey));
  } catch {
    return false;
  }
}
