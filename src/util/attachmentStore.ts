import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

// Holds the decoded bytes of files the app sends down over the relay, in a private
// scratch dir keyed by the "#n" reference the model sees, so the save_attachment tool
// can write one back out to a real path on demand. Ported/adapted from tree-cli
// (which persisted paste/drop bytes); here the source is inbound relay attachments.

export interface StoredAttachment {
  n: number;
  path: string; // absolute scratch-file path holding the decoded bytes
  mediaType: string;
  name: string; // original filename from the app
}

export class AttachmentStore {
  private dir: string | null = null;
  private readonly byN = new Map<number, StoredAttachment>();
  private nextN = 1;

  private ensureDir(): string {
    // mkdtemp gives a 0700 dir; created lazily so a session that never receives an
    // attachment leaves no temp files behind.
    if (!this.dir) this.dir = mkdtempSync(join(tmpdir(), "privateer-att-"));
    return this.dir;
  }

  // Persist an inbound attachment's bytes, assign it the next ref number, and return
  // the stored record (its ref + scratch path).
  register(file: { name: string; mediaType: string; base64: string }): StoredAttachment {
    const n = this.nextN++;
    const path = join(this.ensureDir(), `att-${n}${extname(file.name) || ""}`);
    writeFileSync(path, Buffer.from(file.base64, "base64"));
    const stored: StoredAttachment = { n, path, mediaType: file.mediaType, name: file.name };
    this.byN.set(n, stored);
    return stored;
  }

  get(n: number): StoredAttachment | undefined {
    return this.byN.get(n);
  }

  // Held reference numbers, ascending — for a helpful error when a missing one is asked for.
  refs(): number[] {
    return [...this.byN.keys()].sort((a, b) => a - b);
  }

  cleanup(): void {
    if (!this.dir) return;
    rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
    this.byN.clear();
  }
}
