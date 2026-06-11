import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

// The on-disk state of a single file at a moment in time. `existed: false` means the
// file was absent (so restoring deletes it). When it existed, `hash` keys its content
// in the blob store rather than inlining it, so the index stays small and repeated
// content across turns is stored once.
export interface FileState {
  existed: boolean;
  hash?: string;
}

export interface Checkpoint {
  id: string;
  label: string;
  ts: number;
  messagesLength: number; // engine.messages length at checkpoint time
  committedLength: number; // UI transcript length at checkpoint time
  files: Record<string, FileState>; // absolute path → state captured at checkpoint time
}

export type RewindScope = "conversation" | "files" | "both";

// The serialized index for one session's checkpoints. Blob bodies live separately
// (content-addressed under `blobs/`), so this stays compact regardless of file size.
interface PersistedIndex {
  seq: number;
  original: Record<string, FileState>;
  touched: string[];
  checkpoints: Checkpoint[];
}

// Content-addressed file-content store. Backed by disk when a directory is given (so
// snapshots survive a restart) or an in-memory map otherwise (live-session only, used
// by tests and any non-persisted store). Identical content is stored once under its
// sha256, which keeps growth bounded since most turns touch few files and content
// repeats heavily across checkpoints.
class BlobStore {
  private mem = new Map<string, string>();

  constructor(private dir?: string) {}

  put(content: string): string {
    const hash = createHash("sha256").update(content).digest("hex");
    if (this.dir) {
      const p = join(this.dir, hash);
      if (!existsSync(p)) {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(p, content, "utf8");
      }
    } else {
      this.mem.set(hash, content);
    }
    return hash;
  }

  get(hash: string): string | undefined {
    if (this.dir) {
      const p = join(this.dir, hash);
      return existsSync(p) ? readFileSync(p, "utf8") : undefined;
    }
    return this.mem.get(hash);
  }
}

// Undo for the agent's edits, durable when bound to a session directory. A checkpoint
// is taken before each turn, capturing the conversation length and the current content
// of every file the session has modified so far. The first time any file is mutated we
// also record its original (pre-modification) state, so a rewind can restore files
// first touched after a checkpoint back to their baseline — or delete files the session
// created. When constructed with a directory the index and blobs are persisted there,
// so `/rewind` keeps working after the process restarts and the session is resumed.
export class CheckpointStore {
  private original = new Map<string, FileState>();
  private touched = new Set<string>();
  private checkpoints: Checkpoint[] = [];
  private seq = 0;
  private blobs: BlobStore;

  constructor(private dir?: string) {
    this.blobs = new BlobStore(dir ? join(dir, "blobs") : undefined);
  }

  // Rehydrate a store from a session's checkpoint directory (or a fresh, empty store
  // bound to that directory when nothing has been persisted there yet).
  static load(dir: string): CheckpointStore {
    const store = new CheckpointStore(dir);
    store.loadFrom(dir);
    return store;
  }

  private loadFrom(dir: string): void {
    try {
      const p = join(dir, "index.json");
      if (!existsSync(p)) return;
      const data = JSON.parse(readFileSync(p, "utf8")) as PersistedIndex;
      this.seq = data.seq ?? 0;
      this.original = new Map(Object.entries(data.original ?? {}));
      this.touched = new Set(data.touched ?? []);
      this.checkpoints = data.checkpoints ?? [];
    } catch {
      /* corrupt index: start fresh rather than crash */
    }
  }

  // Re-point this store at a different session's persisted checkpoints, replacing all
  // in-memory state. Used when `/resume` swaps the live conversation for a stored one:
  // the engine's existing recordMutation closure keeps pointing at this instance, so we
  // mutate it in place rather than constructing a new store.
  adopt(dir: string): void {
    this.dir = dir;
    this.blobs = new BlobStore(join(dir, "blobs"));
    this.original = new Map();
    this.touched = new Set();
    this.checkpoints = [];
    this.seq = 0;
    this.loadFrom(dir);
  }

  private captureFileState(abs: string): FileState {
    if (!existsSync(abs)) return { existed: false };
    try {
      return { existed: true, hash: this.blobs.put(readFileSync(abs, "utf8")) };
    } catch {
      return { existed: false };
    }
  }

  private applyFileState(abs: string, state: FileState): void {
    if (state.existed && state.hash != null) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, this.blobs.get(state.hash) ?? "", "utf8");
    } else if (existsSync(abs)) {
      rmSync(abs, { force: true });
    }
  }

  private persist(): void {
    if (!this.dir) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const data: PersistedIndex = {
        seq: this.seq,
        original: Object.fromEntries(this.original),
        touched: [...this.touched],
        checkpoints: this.checkpoints,
      };
      writeFileSync(join(this.dir, "index.json"), JSON.stringify(data), "utf8");
    } catch {
      /* persistence is best-effort; the in-memory store stays usable */
    }
  }

  // Called by write/edit immediately before they mutate `abs`.
  recordMutation(abs: string): void {
    if (!this.original.has(abs)) this.original.set(abs, this.captureFileState(abs));
    this.touched.add(abs);
    this.persist();
  }

  create(opts: { messagesLength: number; committedLength: number; label: string }): Checkpoint {
    const files: Record<string, FileState> = {};
    for (const p of this.touched) files[p] = this.captureFileState(p);
    const cp: Checkpoint = {
      id: `cp${++this.seq}`,
      label: opts.label.replace(/\s+/g, " ").trim().slice(0, 60) || "(turn)",
      ts: Date.now(),
      messagesLength: opts.messagesLength,
      committedLength: opts.committedLength,
      files,
    };
    this.checkpoints.push(cp);
    this.persist();
    return cp;
  }

  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  get(id: string): Checkpoint | undefined {
    return this.checkpoints.find((c) => c.id === id);
  }

  // Restore every session-touched file to its state as of `cp`: the checkpoint's
  // snapshot if present, otherwise the file's original (pre-first-touch) state.
  restoreFiles(cp: Checkpoint): void {
    for (const abs of this.touched) {
      this.applyFileState(abs, cp.files[abs] ?? this.original.get(abs) ?? { existed: false });
    }
  }
}
