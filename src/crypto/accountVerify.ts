/**
 * Account signature verification — TERMINAL side.
 *
 * Phase 4 closes the authenticity gap in app→terminal channel config (review finding
 * F7/F8): a sealed box gives confidentiality but NOT sender authenticity, so a hostile
 * relay/server — which knows this terminal's public key — could forge a channel-save
 * (attacker's token + injected admins). To stop that, the app SIGNS every channel-save
 * with an Ed25519 key derived from the account master key, and the terminal verifies
 * that signature against the account's signing public key it PINNED at link time
 * (accountTrust.ts). Only the master-key holder can produce a valid signature, so the
 * server can neither forge config nor alter the admin list undetected.
 *
 * The canonical message construction MUST stay byte-for-byte in sync with the signer:
 *   treeview/client/services/accountSign.ts
 * Domain prefix "privateer-channel-cfg-v1" + canonical JSON (recursively key-sorted).
 */

import { ed25519 } from "@noble/curves/ed25519";

const enc = new TextEncoder();
const DOMAIN = "privateer-channel-cfg-v1";

// Deterministic JSON: object keys sorted recursively, arrays kept in order. MUST match
// treeview/client/services/accountSign.ts canonicalize() exactly.
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

// The signed envelope. `termId` binds the intended recipient terminal (so a signature
// for terminal X can't be replayed against Y — verification uses OUR termId). `ts`
// binds freshness (the daemon rejects a ts it has already applied → no replay/rollback).
export interface ChannelSaveEnvelope {
  termId: string;
  ts: number;
  draft: Record<string, unknown>;
  sealedSecrets?: string;
}

export function channelSaveMessage(env: ChannelSaveEnvelope): Uint8Array {
  return enc.encode(
    DOMAIN +
      canonicalize({
        termId: env.termId,
        ts: env.ts,
        draft: env.draft,
        sealedSecrets: env.sealedSecrets ?? null,
      }),
  );
}

/** Verify an Ed25519 signature (base64) over the canonical envelope against the pinned
 *  account signing public key (base64). Returns false on ANY malformation — the caller
 *  fail-closes (rejects the save) on false. */
export function verifyChannelSave(accountSignPubB64: string, env: ChannelSaveEnvelope, sigB64: string): boolean {
  try {
    const pub = new Uint8Array(Buffer.from(accountSignPubB64, "base64"));
    const sig = new Uint8Array(Buffer.from(sigB64, "base64"));
    if (pub.length !== 32) return false;
    return ed25519.verify(sig, channelSaveMessage(env), pub);
  } catch {
    return false;
  }
}

// The outbox recipient key (X25519) is fetched live from the UNTRUSTED server, so a
// malicious server could otherwise substitute a key it controls and read every sealed
// result (the terminal holds no master key and can't derive the real one itself). To
// stop that, the app signs the published outbox public key with the same account
// Ed25519 key the terminal already pinned at link, and the terminal verifies that
// signature here before sealing to the key. A server that turns malicious AFTER link
// can no longer swap the key — it can't forge this signature. Residual: the F1
// link-moment window, identical to the channel-config path.
//
// Message construction MUST stay byte-for-byte in sync with the signer:
//   treeview/client/services/accountSign.ts signOutboxKey()
const OUTBOX_KEY_DOMAIN = "privateer-outbox-key-v1";

/** Verify the account's Ed25519 signature (base64) over the base64 outbox public key
 *  against the pinned account signing public key (base64). Returns false on ANY
 *  malformation — the caller fail-closes (refuses to seal) on false. */
export function verifyOutboxKey(accountSignPubB64: string, outboxPubB64: string, sigB64: string): boolean {
  try {
    const pub = new Uint8Array(Buffer.from(accountSignPubB64, "base64"));
    const sig = new Uint8Array(Buffer.from(sigB64, "base64"));
    if (pub.length !== 32) return false;
    return ed25519.verify(sig, enc.encode(OUTBOX_KEY_DOMAIN + outboxPubB64), pub);
  } catch {
    return false;
  }
}

// ── Generic signed control frames (H2) ──────────────────────────────────────────
// channels_save is signed (F7/F8), but every OTHER app→terminal mutation
// (routines_*, extensions_*, skills_*, channels_remove) was sent over the untrusted
// relay UNSIGNED — so a malicious server could forge them, and several have severe
// local side effects (a forged routine runs a headless bypass-mode session → RCE; a
// forged extensions_add installs an npm package → RCE; a forged skills_create injects
// an auto-invoked system-prompt skill). This closes that: the app signs every mutating
// control frame with the account key the terminal pinned at link, and the terminal
// verifies it here (fail-closed) before acting. `termId` binds the recipient (a
// signature for terminal X won't verify against Y) and `ts` binds freshness (the caller
// rejects a ts at/below the last it applied → no replay).
//
// The canonical message construction MUST stay byte-for-byte in sync with the signer:
//   treeview/client/services/accountSign.ts signControl()
const CONTROL_DOMAIN = "privateer-control-v1";

export interface ControlEnvelope {
  termId: string;
  ts: number;
  action: string; // the frame type, e.g. "routines_save", "extensions_add"
  args: Record<string, unknown>; // the operation's parameters
}

export function controlMessage(env: ControlEnvelope): Uint8Array {
  return enc.encode(
    CONTROL_DOMAIN +
      canonicalize({ action: env.action, args: env.args, termId: env.termId, ts: env.ts }),
  );
}

/** Verify an Ed25519 signature (base64) over a control envelope against the pinned
 *  account signing public key (base64). Returns false on ANY malformation — the caller
 *  fail-closes (refuses the mutation) on false. */
export function verifyControl(accountSignPubB64: string, env: ControlEnvelope, sigB64: string): boolean {
  try {
    const pub = new Uint8Array(Buffer.from(accountSignPubB64, "base64"));
    const sig = new Uint8Array(Buffer.from(sigB64, "base64"));
    if (pub.length !== 32) return false;
    return ed25519.verify(sig, controlMessage(env), pub);
  } catch {
    return false;
  }
}
