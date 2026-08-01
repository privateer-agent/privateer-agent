// The cloud outbox sender — sealed E2EE store-and-forward from this machine to
// the account's app.
//
// Lifted out of the harbor (which owned it privately) because it is no longer only
// the harbor's: an INTERACTIVE remote-drive session needs it too. When the app is
// closed — or its socket is simply gone — a driven turn still finishes, and until
// now its answer went nowhere: the relay drops frames with no controller attached,
// so the reply was written to a socket nobody was reading. Sealing it here puts it
// in the account's Inbox instead (see src/cli/chat.ts → deliverUnwatchedTurn).
//
// The terminal holds NO account key material: it seals TO the account's published
// X25519 public key and can never open what it (or any other terminal) wrote. That
// key comes from the UNTRUSTED server, so it is only used once the account's Ed25519
// signature over it verifies against the key pinned at link time. Fail closed: no
// pin, no signature, or a bad signature ⇒ we don't seal at all, and the caller falls
// back to its own durable channel (a queue, a file, a notice).
//
// Module-level caches (pubkey, machine origin) — one per process, exactly like the
// per-instance caches this replaced.

import { apiRequest, defaultDeviceLabel } from "../auth/privateer.ts";
import { loadAccountSignKey } from "../crypto/accountTrust.ts";
import { verifyOutboxKey } from "../crypto/accountVerify.ts";
import { sealJson, decodeAccountPublicKey } from "../crypto/outboxSeal.ts";
import { routineRelayId, type OutboxKind } from "../routines/store.ts";

export type { OutboxKind };

// Plaintext cap per sealed item. The server rejects anything over ~128 KB of
// base64; this keeps us well inside that with room for the envelope, and matches
// the mailbox's purpose — summaries and answers, not transcripts.
export const MAX_CLOUD_PLAINTEXT = 45_000;

let outboxPub: Uint8Array | undefined;
let originCache: { id: string; label: string } | undefined;

/** Fetch + verify the account's outbox public key (cached for the process). */
export async function ensureOutboxPub(): Promise<Uint8Array | undefined> {
  if (outboxPub) return outboxPub;
  try {
    const res = await apiRequest("/api/outbox/pubkey");
    if (!res.ok) return undefined;
    const data = (await res.json()) as { outboxPublicKey?: string | null; outboxPublicKeySig?: string | null };
    if (!data.outboxPublicKey || !data.outboxPublicKeySig) return undefined;
    // Verify the account's signature over the key against the signing key pinned at
    // link — otherwise a malicious server could substitute a key it controls and read
    // every result we seal.
    const accountPub = loadAccountSignKey();
    if (!accountPub) return undefined;
    if (!verifyOutboxKey(accountPub, data.outboxPublicKey, data.outboxPublicKeySig)) return undefined;
    outboxPub = decodeAccountPublicKey(data.outboxPublicKey);
    return outboxPub;
  } catch {
    return undefined;
  }
}

/**
 * This machine's origin tag, embedded (E2EE) in every sealed result so the app can
 * show WHICH box produced it. The outbox record itself is account-only, so attribution
 * can only live inside the sealed blob — where a hostname is allowed, since the server
 * never sees it. `id` is this install's stable relay id; `label` the device name.
 */
export function machineOrigin(): { id: string; label: string } {
  if (!originCache) originCache = { id: routineRelayId(), label: defaultDeviceLabel() };
  return originCache;
}

/**
 * Seal one result to the account outbox and POST the ciphertext. Returns whether the
 * server accepted it; false covers every failure (no verified key, offline, rejected)
 * and means the caller must fall back to its own durable channel.
 */
export async function postOutbox(
  name: string,
  at: string,
  status: "ok" | "error",
  content: string,
  kind: OutboxKind = "routine",
): Promise<boolean> {
  const pub = await ensureOutboxPub();
  if (!pub) return false;
  const body = content.length > MAX_CLOUD_PLAINTEXT ? content.slice(0, MAX_CLOUD_PLAINTEXT) + "\n…truncated" : content;
  const sealed = sealJson(pub, { v: 1, kind, name, status, at, content: body, origin: machineOrigin() });
  try {
    const res = await apiRequest("/api/outbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sealed }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
