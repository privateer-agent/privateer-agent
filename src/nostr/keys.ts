/**
 * The agent's Nostr identity.
 *
 * A Nostr secret key is not a bot token. It is a PERMANENT identity: it cannot be
 * rotated without becoming a different participant, everything it ever signed stays
 * attributable to it, and there is no issuer to revoke it. So it gets the same
 * treatment as the terminal identity key — minted locally, written 0600, and never
 * sent anywhere — rather than living in plaintext config.json beside the revocable
 * platform bot tokens.
 *
 * DEFAULT PATH: the agent generates its own keypair and reports the npub, which the
 * user pastes into their Buzz workspace so an Owner can add it as a Bot member. The
 * secret never crosses a wire, not even the sealed app→terminal channel.
 *
 * IMPORT PATH: a user who already has a Buzz identity can send an nsec through the
 * app's sealed-secret flow; importBuzzKey() moves it into the 0600 file so it stops
 * living in config.json.
 *
 * Construction mirrors crypto/terminalKey.ts deliberately, including the 0600
 * TOCTOU-avoiding write and the process-lifetime cache.
 */

import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { globalDir } from "../config/paths.ts";
import { npubEncode, npubDecode, nsecEncode, nsecDecode } from "./bech32.ts";

interface BuzzKeyFile {
  v: 1;
  secretKey: string; // base64, 32 raw bytes — never leaves this machine
}

export interface BuzzIdentity {
  secretHex: string;
  pubkeyHex: string;
  npub: string;
}

function keyPath(): string {
  return join(globalDir(), "buzz-key.json");
}

let cached: BuzzIdentity | undefined;

// ── pure ────────────────────────────────────────────────────────────────────────

/** A fresh 32-byte secp256k1 secret key. */
export function generateSecretKey(): Uint8Array {
  return schnorr.utils.randomSecretKey();
}

/** The 32-byte x-only public key for a secret, as lowercase hex — a Nostr pubkey. */
export function publicKeyHex(secret: Uint8Array | string): string {
  return bytesToHex(schnorr.getPublicKey(typeof secret === "string" ? hexToBytes(secret) : secret));
}

/**
 * Normalize a configured identity to lowercase hex.
 *
 * Allowlists are written by humans, who will paste whichever form Buzz showed them —
 * so accept both npub and raw hex and store one canonical form. Returns undefined
 * for anything that isn't a valid 32-byte key, so a typo'd entry fails closed
 * (dropped from the allowlist) rather than silently matching nothing forever.
 */
export function toHexPubkey(npubOrHex: string): string | undefined {
  const s = npubOrHex.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (s.startsWith("npub1")) {
    try {
      return bytesToHex(npubDecode(s));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Accept either an nsec or raw hex secret; throws on anything else. */
export function secretFromNsec(nsecOrHex: string): Uint8Array {
  const s = nsecOrHex.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return hexToBytes(s.toLowerCase());
  if (s.startsWith("nsec1")) return nsecDecode(s);
  throw new Error("expected an nsec1… key or 64 hex characters");
}

function identityFrom(secret: Uint8Array): BuzzIdentity {
  const pubkeyHex = publicKeyHex(secret);
  return { secretHex: bytesToHex(secret), pubkeyHex, npub: npubEncode(hexToBytes(pubkeyHex)) };
}

// ── persisted ───────────────────────────────────────────────────────────────────

function persist(secret: Uint8Array): BuzzIdentity {
  const file: BuzzKeyFile = { v: 1, secretKey: Buffer.from(secret).toString("base64") };
  // 0600 from creation — see terminalKey.ts for why `mode` plus a follow-up chmod.
  writeFileSync(keyPath(), JSON.stringify(file), { mode: 0o600 });
  try {
    chmodSync(keyPath(), 0o600);
  } catch {
    /* best effort — e.g. non-POSIX FS */
  }
  cached = identityFrom(secret);
  return cached;
}

/** Load the persisted identity, minting and persisting one on first use. */
export function loadOrCreateBuzzKey(): BuzzIdentity {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(readFileSync(keyPath(), "utf8")) as BuzzKeyFile;
    if (parsed?.v === 1 && parsed.secretKey) {
      const buf = Buffer.from(parsed.secretKey, "base64");
      if (buf.length === 32) {
        cached = identityFrom(new Uint8Array(buf));
        return cached;
      }
    }
  } catch {
    /* missing or malformed → mint a fresh keypair below */
  }
  return persist(generateSecretKey());
}

/**
 * Adopt an existing identity, replacing any current one.
 *
 * Called when a user supplies an nsec through the app: the value arrives sealed,
 * lands here, and the caller then deletes it from config.json so the only copy on
 * disk is the 0600 file.
 */
export function importBuzzKey(nsecOrHex: string): BuzzIdentity {
  return persist(secretFromNsec(nsecOrHex));
}

/**
 * Every textual form of the persisted secret, for the outbound redactor.
 *
 * The agent can read its own key file — it's a file on the machine it operates —
 * so without this it could quote its permanent identity into a public channel.
 * Both encodings are returned because either could plausibly appear in output.
 * Non-minting: no key file means nothing to redact.
 */
export function buzzRedactionSecrets(): string[] {
  const secretHex = cached?.secretHex ?? readPersistedSecretHex();
  if (!secretHex) return [];
  return [secretHex, nsecEncode(hexToBytes(secretHex))];
}

function readPersistedSecretHex(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(keyPath(), "utf8")) as BuzzKeyFile;
    const buf = Buffer.from(parsed?.secretKey ?? "", "base64");
    if (parsed?.v === 1 && buf.length === 32) return bytesToHex(new Uint8Array(buf));
  } catch {
    /* not configured yet */
  }
  return undefined;
}

/**
 * Read the persisted npub WITHOUT minting one.
 *
 * Side-effect-free by design: the app lists every platform, configured or not, and
 * merely rendering an empty Buzz card must not conjure a permanent identity.
 */
export function peekBuzzNpub(): string | undefined {
  if (cached) return cached.npub;
  const secretHex = readPersistedSecretHex();
  return secretHex ? identityFrom(hexToBytes(secretHex)).npub : undefined;
}
