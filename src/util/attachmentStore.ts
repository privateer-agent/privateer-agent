import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

// Holds the decoded bytes of files the app sends down over the relay, in a private
// scratch dir keyed by the "#n" reference the model sees, so the save_attachment tool
// can write one back out to a real path on demand. Ported/adapted from tree-cli
// (which persisted paste/drop bytes); here the source is inbound relay attachments.
//
// A DESKTOP attachment arrives as a path instead of bytes — the app and this agent
// share a disk, so there is nothing to transfer and nothing to stage. Such an entry
// simply points at the file where it already lives; `owned` is what tells the two
// apart, so cleanup() removes only what we wrote. That is also why the desktop
// composer has no attachment size cap: a 4 GB video costs one string here.

export interface StoredAttachment {
  n: number;
  path: string; // absolute path holding the bytes — our scratch file, or the user's own file
  mediaType: string;
  name: string; // original filename from the app
  owned: boolean; // did WE write this file? false for a desktop path hand-off
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

  // Register an inbound attachment under the next ref number and return the stored
  // record. Bytes are staged into the scratch dir; a `path` (desktop) is adopted
  // as-is — copying a file the agent can already open would be pure waste, and for
  // the large files this path exists to carry, waste measured in gigabytes.
  register(file: { name: string; mediaType: string; base64?: string; path?: string }): StoredAttachment {
    const n = this.nextN++;
    if (file.path) {
      const stored: StoredAttachment = {
        n, path: file.path, mediaType: file.mediaType, name: file.name, owned: false,
      };
      this.byN.set(n, stored);
      return stored;
    }
    const path = join(this.ensureDir(), `att-${n}${extname(file.name) || ""}`);
    writeFileSync(path, Buffer.from(file.base64 ?? "", "base64"));
    const stored: StoredAttachment = {
      n, path, mediaType: file.mediaType, name: file.name, owned: true,
    };
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
