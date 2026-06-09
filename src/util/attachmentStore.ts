import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import type { Attachment, Modality } from "./images.ts";

// One stored attachment: its bytes persisted to a stable scratch file, keyed by the
// "#n" reference the user sees in the prompt.
export interface StoredAttachment {
  n: number;
  path: string; // absolute scratch-file path holding the decoded bytes
  mediaType: string;
  modality: Modality;
  origin: string; // the token the user referenced (for display/debugging)
}

// Keeps the decoded bytes of every attachment seen this session in a private scratch
// dir, keyed by its "[Kind #n]" reference, so the `save_attachment` tool can write one
// back out to a real path on demand.
//
// This exists to close the macOS file-promise drop gap: the bytes we capture at
// paste-time (in resolveAttachments) are the only durable copy — the terminal's
// …/T/drop-XXXXXX/ file is a volatile stub that may already be gone or truncated by the
// time the agent goes looking. We copy what we captured into a place we control, once,
// instead of trusting that path twice.
export class AttachmentStore {
  private dir: string | null = null;
  private readonly byN = new Map<number, StoredAttachment>();

  private ensureDir(): string {
    // mkdtemp gives a 0700 dir; created lazily so a session that never attaches
    // anything leaves no temp files behind.
    if (!this.dir) this.dir = mkdtempSync(join(tmpdir(), "privateer-att-"));
    return this.dir;
  }

  // Persist an attachment's bytes to the scratch dir, keyed by n. Idempotent: the same
  // n (a file referenced twice in a session) is written once and reused.
  register(att: Attachment): StoredAttachment | undefined {
    if (att.n == null) return undefined;
    const existing = this.byN.get(att.n);
    if (existing) return existing;
    const file = join(this.ensureDir(), `att-${att.n}${extname(att.path)}`);
    writeFileSync(file, Buffer.from(att.data, "base64"));
    const stored: StoredAttachment = {
      n: att.n,
      path: file,
      mediaType: att.mediaType,
      modality: att.modality,
      origin: att.path,
    };
    this.byN.set(att.n, stored);
    return stored;
  }

  get(n: number): StoredAttachment | undefined {
    return this.byN.get(n);
  }

  // The reference numbers currently held, ascending — for a helpful error when the
  // model asks for one that isn't there.
  refs(): number[] {
    return [...this.byN.keys()].sort((a, b) => a - b);
  }

  // Remove the scratch dir (e.g. on session exit). Safe to call when nothing was stored.
  cleanup(): void {
    if (!this.dir) return;
    rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
    this.byN.clear();
  }
}
