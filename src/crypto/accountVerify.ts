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
