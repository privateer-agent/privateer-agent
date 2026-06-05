import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

// The on-disk state of a single file at a moment in time. `existed: false` means the
// file was absent (so restoring deletes it).
export interface FileState {
  existed: boolean;
  content?: string;
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

function captureFileState(abs: string): FileState {
  if (!existsSync(abs)) return { existed: false };
  try {
    return { existed: true, content: readFileSync(abs, "utf8") };
  } catch {
    return { existed: false };
  }
}

function applyFileState(abs: string, state: FileState): void {
  if (state.existed) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, state.content ?? "", "utf8");
  } else if (existsSync(abs)) {
    rmSync(abs, { force: true });
  }
}

// Session-scoped undo for the agent's edits. A checkpoint is taken before each turn,
// capturing the conversation length and the current content of every file the session
// has modified so far. The first time any file is mutated we also record its original
// (pre-modification) state, so a rewind can restore files first touched after a
// checkpoint back to their baseline — or delete files the session created.
export class CheckpointStore {
  private original = new Map<string, FileState>();
  private touched = new Set<string>();
  private checkpoints: Checkpoint[] = [];
  private seq = 0;

  // Called by write/edit immediately before they mutate `abs`.
  recordMutation(abs: string): void {
    if (!this.original.has(abs)) this.original.set(abs, captureFileState(abs));
    this.touched.add(abs);
  }

  create(opts: { messagesLength: number; committedLength: number; label: string }): Checkpoint {
    const files: Record<string, FileState> = {};
    for (const p of this.touched) files[p] = captureFileState(p);
    const cp: Checkpoint = {
      id: `cp${++this.seq}`,
      label: opts.label.replace(/\s+/g, " ").trim().slice(0, 60) || "(turn)",
      ts: Date.now(),
      messagesLength: opts.messagesLength,
      committedLength: opts.committedLength,
      files,
    };
    this.checkpoints.push(cp);
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
      applyFileState(abs, cp.files[abs] ?? this.original.get(abs) ?? { existed: false });
    }
  }
}
