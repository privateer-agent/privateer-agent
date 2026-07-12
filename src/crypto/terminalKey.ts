/**
 * Terminal identity keypair — the RECIPIENT side of app→terminal sealing.
 *
 * The outbox (crypto/outboxSeal.ts) is one-directional: a terminal seals results TO
 * the account and holds no openable key. This is the mirror: a persistent X25519
 * keypair whose PUBLIC half the app pins at link time (device-code approval) and
 * whose PRIVATE half never leaves this machine — so the app can seal secrets (Phase
 * 3: channel bot tokens) that ONLY this terminal can open, with the server unable to
 * read them even though it forwards the ciphertext.
 *
 * Trust model (TOFU, SSH known_hosts style): the pubkey is delivered to the app once,
 * bound into the device-authorization grant, and pinned on approval. A later key swap
 * over the relay is rejected because it isn't in the pinned set. This does NOT defend
 * against a malicious server at the single link moment — that narrow window is the
 * accepted TOFU limitation (fingerprint verification is the future hardening).
 *
 * Construction matches outboxSeal.ts so Phase 3's open() is the exact inverse of the
 * app's seal(): X25519 → HKDF-SHA256 → AES-256-GCM.
 */

import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { x25519 } from "@noble/curves/ed25519";
import { globalDir } from "../config/paths.ts";

interface TerminalKeyFile {
  v: 1;
  publicKey: string; // base64, 32 raw bytes
  secretKey: string; // base64, 32 raw bytes — never leaves this machine
}

function keyPath(): string {
  return join(globalDir(), "terminal-key.json");
}

// Cache the loaded/created keypair for the process lifetime so we don't re-read the
// file (or, worse, regenerate) on every device-code request.
let cached: { publicKey: Uint8Array; secretKey: Uint8Array } | undefined;

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromB64(s: string, label: string): Uint8Array {
  const buf = Buffer.from(s, "base64");
  if (buf.length !== 32) throw new Error(`${label} must be 32 bytes`);
  return new Uint8Array(buf);
}

// Load the persisted keypair, or mint + persist a fresh one on first use. The file is
// written 0600 (owner-only) — this machine's private key protects every future sealed
// message to this terminal, so it's as sensitive as the config.json tokens beside it.
function loadOrCreate(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(readFileSync(keyPath(), "utf8")) as TerminalKeyFile;
    if (parsed?.v === 1 && parsed.publicKey && parsed.secretKey) {
      cached = {
        publicKey: fromB64(parsed.publicKey, "terminal public key"),
        secretKey: fromB64(parsed.secretKey, "terminal secret key"),
      };
      return cached;
    }
  } catch {
    /* missing or malformed → mint a fresh keypair below */
  }
  const secretKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(secretKey);
  const file: TerminalKeyFile = { v: 1, publicKey: b64(publicKey), secretKey: b64(secretKey) };
  // Create 0600 from the start — passing `mode` to writeFileSync avoids the TOCTOU
  // window where a fresh file briefly carries umask perms (group/world-readable)
  // before a follow-up chmod. `mode` only applies on CREATE, so also chmod to fix an
  // OVERWRITTEN pre-existing (malformed) file, whose perms writeFileSync leaves as-is.
  writeFileSync(keyPath(), JSON.stringify(file), { mode: 0o600 });
  try {
    chmodSync(keyPath(), 0o600);
  } catch {
    /* best effort — e.g. non-POSIX FS */
  }
  cached = { publicKey, secretKey };
  return cached;
}

/** This terminal's public key, base64 (32 raw bytes). Sent in the device-code grant
 *  so the app can pin it; safe to expose (it's public). Mints the keypair on first
 *  call. */
export function terminalPublicKeyBase64(): string {
  return b64(loadOrCreate().publicKey);
}

/** This terminal's private key (raw 32 bytes) — for Phase 3's unseal(). Never send,
 *  log, or persist anywhere but the 0600 key file. */
export function terminalSecretKey(): Uint8Array {
  return loadOrCreate().secretKey;
}
