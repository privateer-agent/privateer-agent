// Media staged for ONE unattended result — the stills, clips and files an agent
// wants the user to actually see in their Privateer Inbox, rather than describe.
//
// WHY THIS EXISTS. A routine can already generate media (src/tools/media.ts) and
// compose it (videoCompose.ts), but until now the run could only ever say where it
// put the file. Nobody is at that machine — that is the whole premise of an
// unattended run — so "saved to ~/.privateer/media/still-3.png" is a result the
// user cannot open from the surface they were handed. `send_file_to_client` doesn't
// close that gap either: it needs a controller attached RIGHT NOW, which is exactly
// what a 7am routine doesn't have.
//
// So the run stages files here (the attach_to_result tool — src/tools/attachResult.ts),
// and delivery seals them to the account outbox alongside the message: small ones
// inline in the envelope, larger ones as sealed blobs the app collects on the same
// sync (src/outbox/cloudOutbox.ts). Store-and-forward, E2EE, no controller needed.
//
// The ceilings below are the honest part. They are checked at STAGE time, not at
// delivery time, so the model learns "that clip is too big" while it can still do
// something about it (re-encode, trim, attach a frame instead) rather than after the
// turn has ended. A refusal is never traded against something already staged.

import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { mediaTypeForPath } from "../tools/sendFile.ts";

/** Most files one result may carry. */
export const MAX_ATTACHMENTS = 6;
/** Largest single file, matching the server's per-blob ceiling. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** Largest total per result — bounds one run's share of the account's mailbox. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 24 * 1024 * 1024;

/** How the app should present an attachment. Derived from the media type. */
export type MediaClass = "image" | "video" | "audio" | "file";

export interface StagedMedia {
  /** Per-result id; ties the envelope's metadata to its bytes. */
  id: string;
  /** Absolute path on THIS machine. Never leaves it — see the note in delivery. */
  path: string;
  name: string;
  mediaType: string;
  cls: MediaClass;
  size: number;
  caption?: string;
}

export function classifyMedia(mediaType: string): MediaClass {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return "file";
}

export type StageResult =
  | { ok: true; item: StagedMedia }
  | { ok: false; reason: string };

/**
 * One run's staging area. Created per routine/task run and thrown away with it, so
 * a file staged by yesterday's run can never ride along with today's.
 */
export class ResultMedia {
  private items: StagedMedia[] = [];

  /** Bytes staged so far. */
  totalBytes(): number {
    return this.items.reduce((n, m) => n + m.size, 0);
  }

  list(): StagedMedia[] {
    return [...this.items];
  }

  clear(): void {
    this.items = [];
  }

  /**
   * Stage one file. `cwd` resolves a relative path the same way the run's other
   * file tools do. Re-staging the same path REPLACES the earlier entry (a model
   * that regenerates an image and attaches it again means the new one), which also
   * stops a retry loop from eating the count cap.
   */
  stage(path: string, cwd: string, caption?: string): StageResult {
    const abs = isAbsolute(path) ? path : resolve(cwd, path);
    if (!existsSync(abs)) return { ok: false, reason: `File not found: ${path}` };
    const stat = statSync(abs);
    if (stat.isDirectory()) return { ok: false, reason: `${path} is a directory — attach a single file.` };
    if (stat.size === 0) return { ok: false, reason: `${path} is empty — nothing to attach.` };
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        reason: `${basename(abs)} is ${mb(stat.size)} MB; the inbox caps one attachment at ${mb(MAX_ATTACHMENT_BYTES)} MB. Re-encode it smaller, trim it, or attach a single frame instead.`,
      };
    }

    const existing = this.items.findIndex((m) => m.path === abs);
    const others = existing >= 0 ? this.items.filter((_, i) => i !== existing) : this.items;
    if (others.length >= MAX_ATTACHMENTS) {
      return { ok: false, reason: `Already carrying ${MAX_ATTACHMENTS} attachments — that is the limit for one result.` };
    }
    const otherBytes = others.reduce((n, m) => n + m.size, 0);
    if (otherBytes + stat.size > MAX_TOTAL_ATTACHMENT_BYTES) {
      return {
        ok: false,
        reason: `That would put this result over the ${mb(MAX_TOTAL_ATTACHMENT_BYTES)} MB attachment budget (${mb(otherBytes)} MB already staged).`,
      };
    }

    const mediaType = mediaTypeForPath(abs);
    const item: StagedMedia = {
      id: randomUUID(),
      path: abs,
      name: basename(abs),
      mediaType,
      cls: classifyMedia(mediaType),
      size: stat.size,
      // A caption is shown under the attachment in the app, so it is worth having
      // and worth bounding — this is model-authored text heading for a UI.
      ...(caption?.trim() ? { caption: caption.trim().slice(0, 200) } : {}),
    };
    this.items = [...others, item];
    return { ok: true, item };
  }
}

function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1).replace(/\.0$/, "");
}
