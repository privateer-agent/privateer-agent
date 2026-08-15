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
// ATTACHMENTS. A result may also carry media (routines/resultMedia.ts). The message
// envelope stays small — it is capped by the server at 128KB of base64 — so only a
// thumbnail-sized file rides inside it; anything larger is sealed on its own and
// PUT to /api/outbox/blob, with the envelope carrying just its id and metadata. Both
// halves are sealed to the same account key, so the server holds ciphertext either
// way, and the app collects the blobs on the same sync that opens the message.
//
// Module-level caches (pubkey, machine origin) — one per process, exactly like the
// per-instance caches this replaced.

import { readFileSync, existsSync, statSync } from "node:fs";
import { apiRequest, defaultDeviceLabel } from "../auth/privateer.ts";
import { loadAccountSignKey } from "../crypto/accountTrust.ts";
import { verifyOutboxKey } from "../crypto/accountVerify.ts";
import { sealJson, seal, decodeAccountPublicKey } from "../crypto/outboxSeal.ts";
import { routineRelayId, type OutboxKind } from "../routines/store.ts";
import { MAX_ATTACHMENT_BYTES, type MediaClass, type StagedMedia } from "../routines/resultMedia.ts";

export type { OutboxKind };

// Plaintext cap per sealed item. The server rejects anything over ~128 KB of
// base64; this keeps us well inside that with room for the envelope, and matches
// the mailbox's purpose — summaries and answers, not transcripts.
export const MAX_CLOUD_PLAINTEXT = 45_000;

// Total plaintext an envelope may reach once attachment metadata (and any inline
// bytes) are folded in. 128KB of base64 is 98,304 bytes of plaintext; this leaves
// headroom for the sealed-box overhead and JSON escaping.
const MAX_ENVELOPE_PLAINTEXT = 90_000;

/** Largest file carried INSIDE the envelope rather than as its own blob. */
export const MAX_INLINE_MEDIA_BYTES = 24 * 1024;
/** Total base64 an envelope will spend on inline media, whatever the file count. */
const INLINE_TOTAL_B64_BUDGET = 32 * 1024;

/**
 * One attachment as the app sees it: metadata always, then EITHER `b64` (small
 * enough to inline) or `blobId` (fetch + open separately). Never both, never
 * neither — an attachment we couldn't deliver is dropped from the list and named
 * in the body instead, because a card that can never load is worse than a sentence
 * saying the file stayed on the machine.
 */
export interface OutboxMedia {
  id: string;
  name: string;
  mediaType: string;
  cls: MediaClass;
  size: number;
  caption?: string;
  b64?: string;
  blobId?: string;
}

/**
 * What the run was ASKED to do, carried beside what it answered.
 *
 * A result on its own is a dead end: the app can show it, read it aloud and file
 * it, but "now book the top one" needs the standing instruction the run was given,
 * and the directory it ran in, or the follow-up starts from a summary with no idea
 * what produced it. That context is the routine — it lives on this machine and the
 * app has never seen it — so it rides inside the SEALED envelope (the server holds
 * ciphertext either way, exactly like `origin`).
 *
 * Every field is optional and clipped: this travels on every result, and a routine
 * prompt can be arbitrarily long. Absent → the app falls back to the result body
 * alone, which is what results from older CLIs carry.
 */
export interface OutboxSource {
  /** The saved routine's id, when one produced this. Absent for ad-hoc tasks. */
  routineId?: string;
  /** The instruction the run was given (a routine's `prompt`, a task's spec). */
  prompt?: string;
  /** Where the run executed — a follow-up belongs in the same directory. */
  cwd?: string;
  /** The "provider:model" the run resolved to. */
  model?: string;
  /** The trigger verbatim: a cron expression, or a one-off ISO datetime. */
  schedule?: string;
}

/** Clip bounds for `source`. The prompt is the only field that can be long. */
export const MAX_SOURCE_PROMPT = 2_000;
const SOURCE_FIELD_CAPS: Record<keyof OutboxSource, number> = {
  routineId: 200,
  prompt: MAX_SOURCE_PROMPT,
  cwd: 500,
  model: 200,
  schedule: 100,
};

/**
 * Normalize a source for the envelope: trim, clip, drop empties — and return
 * undefined when nothing survives, so a workflow (or an empty-prompt live spawn)
 * doesn't ship an empty object and bump the envelope version for nothing.
 * Exported for the round-trip test.
 */
export function packSource(source?: OutboxSource): OutboxSource | undefined {
  if (!source) return undefined;
  const out: OutboxSource = {};
  for (const [key, cap] of Object.entries(SOURCE_FIELD_CAPS) as [keyof OutboxSource, number][]) {
    const raw = source[key];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value) continue;
    out[key] = value.length > cap ? value.slice(0, cap) + "…" : value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

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

/** Seal one attachment's bytes and store them. Returns the blob id, or undefined. */
async function uploadBlob(pub: Uint8Array, bytes: Uint8Array): Promise<string | undefined> {
  try {
    const res = await apiRequest("/api/outbox/blob", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sealed: seal(pub, bytes) }),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { id?: string };
    return typeof data.id === "string" ? data.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Delete blobs we uploaded for a message that then failed to post. Best-effort: the
 * server's TTL would collect them anyway, but a queued result re-uploads on its next
 * attempt, and leaving the first copy behind spends the account's blob quota on bytes
 * nothing will ever reference.
 */
async function dropBlobs(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await apiRequest("/api/outbox/blob/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    });
  } catch {
    /* TTL is the backstop */
  }
}

/**
 * Turn staged files into envelope entries, uploading what doesn't fit inline.
 *
 * `budget` is the base64 room left in the envelope after the body. Files are taken
 * in order — the model attached them in the order it wanted them shown — so a small
 * still after a large one still gets its inline slot.
 */
async function packMedia(
  pub: Uint8Array,
  staged: StagedMedia[],
  budget: number,
): Promise<{ media: OutboxMedia[]; blobIds: string[]; undelivered: string[] }> {
  const media: OutboxMedia[] = [];
  const blobIds: string[] = [];
  const undelivered: string[] = [];
  let inlineLeft = Math.max(0, Math.min(budget, INLINE_TOTAL_B64_BUDGET));

  for (const item of staged) {
    // Re-check at delivery: the file was measured when the model attached it, and a
    // run can be long. A file that has since been deleted, replaced with a directory
    // or grown past the cap is named in the body rather than silently dropped.
    let bytes: Uint8Array;
    try {
      if (!existsSync(item.path)) throw new Error("missing");
      const stat = statSync(item.path);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ATTACHMENT_BYTES) throw new Error("unusable");
      bytes = new Uint8Array(readFileSync(item.path));
    } catch {
      undelivered.push(item.name);
      continue;
    }

    const meta: OutboxMedia = {
      id: item.id,
      name: item.name,
      mediaType: item.mediaType,
      cls: item.cls,
      size: bytes.length,
      ...(item.caption ? { caption: item.caption } : {}),
    };

    if (bytes.length <= MAX_INLINE_MEDIA_BYTES) {
      const b64 = Buffer.from(bytes).toString("base64");
      if (b64.length <= inlineLeft) {
        inlineLeft -= b64.length;
        media.push({ ...meta, b64 });
        continue;
      }
    }

    const blobId = await uploadBlob(pub, bytes);
    if (!blobId) {
      undelivered.push(item.name);
      continue;
    }
    blobIds.push(blobId);
    media.push({ ...meta, blobId });
  }

  return { media, blobIds, undelivered };
}

/** A line in the result body for each file that couldn't travel. */
function undeliveredNote(names: string[]): string {
  if (names.length === 0) return "";
  const label = machineOrigin().label;
  return `\n\n---\n\n> ⚠︎ Couldn't deliver ${names.length === 1 ? "one attachment" : `${names.length} attachments`} (${names.join(", ")}) — ${names.length === 1 ? "it is" : "they are"} still on ${label}.\n`;
}

/**
 * Seal one result to the account outbox and POST the ciphertext. Returns whether the
 * server accepted it; false covers every failure (no verified key, offline, rejected)
 * and means the caller must fall back to its own durable channel.
 *
 * `staged` is this run's attachments (routines/resultMedia.ts). They are uploaded
 * BEFORE the message, so a message that lands always references bytes that exist;
 * if the message then fails, the blobs are dropped again and the caller's queued
 * retry re-uploads from the same paths on disk.
 *
 * `source` is what the run was asked to do (see OutboxSource) — the context a
 * follow-up needs, sealed alongside the answer.
 */
export async function postOutbox(
  name: string,
  at: string,
  status: "ok" | "error",
  content: string,
  kind: OutboxKind = "routine",
  staged: StagedMedia[] = [],
  source?: OutboxSource,
): Promise<boolean> {
  const pub = await ensureOutboxPub();
  if (!pub) return false;
  let body = content.length > MAX_CLOUD_PLAINTEXT ? content.slice(0, MAX_CLOUD_PLAINTEXT) + "\n…truncated" : content;

  // Packed before the media budget is struck, because it spends the same envelope:
  // attachments must not be sized against room the source has already taken.
  const packedSource = packSource(source);
  const sourceCost = packedSource ? JSON.stringify(packedSource).length : 0;

  const { media, blobIds, undelivered } = staged.length
    ? await packMedia(pub, staged, MAX_ENVELOPE_PLAINTEXT - body.length - sourceCost - 2_000)
    : { media: [] as OutboxMedia[], blobIds: [] as string[], undelivered: [] as string[] };
  body += undeliveredNote(undelivered);

  // v2 adds `media`, v3 `source`. Both are additive: an older app ignores the field
  // and still renders the body, which is why the note above names undelivered files
  // in prose rather than only in metadata, and why a follow-up degrades to "the
  // result text alone" rather than failing when `source` is missing.
  const envelope: Record<string, unknown> = {
    v: packedSource ? 3 : media.length > 0 ? 2 : 1,
    kind,
    name,
    status,
    at,
    content: body,
    origin: machineOrigin(),
    ...(media.length > 0 ? { media } : {}),
    ...(packedSource ? { source: packedSource } : {}),
  };

  let sealed = sealJson(pub, envelope);
  if (sealed.length > 128 * 1024) {
    // The budget arithmetic above should make this unreachable; if it is ever wrong,
    // the ANSWER is what gets clipped, never the attachments — those are the part the
    // user cannot reconstruct from anywhere else.
    envelope.content = body.slice(0, Math.max(0, MAX_CLOUD_PLAINTEXT / 2)) + "\n…truncated";
    sealed = sealJson(pub, envelope);
  }

  try {
    const res = await apiRequest("/api/outbox", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sealed }),
    });
    if (!res.ok) await dropBlobs(blobIds);
    return res.ok;
  } catch {
    await dropBlobs(blobIds);
    return false;
  }
}
