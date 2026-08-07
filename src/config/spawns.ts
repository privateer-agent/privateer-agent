// Spawn records — the per-folder defaults an agent starts with on this machine.
//
// A "spawn" is one agent pointed at one folder: the desktop's window sessions are
// the visible case, but the record is deliberately machine-level rather than
// desktop-level, because ~/.privateer is shared with the CLI and a `privateer` run
// in the same folder should be able to honour the same defaults later.
//
// WHY NOT THE PROJECT FOLDER. Pi already has a project scope — `.privateer/` and
// `.pi/` under cwd (see PROJECT_CONFIG_DIR_NAMES) — and this is NOT that. Project
// config lives in the tree, travels with a clone, and lands in the user's commits.
// These records are the opposite by choice: which model YOU run in a folder on THIS
// computer is a local preference, not a property of the project, and writing it into
// someone's repo would be a surprise the first time they `git status`. So they live
// under the global dir, keyed by the folder's real path, and the folder itself is
// left untouched. (PRIVATEER.md is the deliberate exception — that one IS about the
// project and belongs in the tree.)
//
// Keying is by REAL path: a symlinked checkout (/var → /private/var on macOS) must
// not read as a second folder, or a spawn would silently lose its defaults depending
// on which route the user opened it by.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { globalDir } from "./paths.ts";

export interface SpawnRecord {
  /** The folder, as resolved when the record was written. */
  path: string;
  /** Preferred model as "provider/id", or null to take the account default. */
  model: string | null;
  /** MCP connector names this folder's agent starts with. */
  connectors: string[];
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the last spawn opened on this folder, or null if never. */
  lastOpenedAt: number | null;
}

/** All spawn records: <globalDir>/spawns/<key>/spawn.json (+ a per-spawn skills/ dir). */
export function spawnsDir(): string {
  return join(globalDir(), "spawns");
}

// The identity of a folder for record purposes. realpathSync resolves symlinks so
// two routes to one checkout share a record; a path that doesn't exist yet (a folder
// the user is about to create) falls back to the lexical resolution rather than
// throwing. Case-folded on Windows, where the same folder is reachable as C:\Foo and
// c:\foo and neither spelling is more correct than the other.
function identity(path: string): string {
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    real = resolve(path);
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** Stable per-folder key. 64 bits of sha256 — collisions are checked, not assumed. */
export function spawnKey(path: string): string {
  return createHash("sha256").update(identity(path)).digest("hex").slice(0, 16);
}

/** This spawn's own directory (records + per-folder skills). */
export function spawnDir(path: string): string {
  return join(spawnsDir(), spawnKey(path));
}

/**
 * Per-spawn skills, injected into the session as an extra skill path so a folder can
 * carry its own without a `.privateer/skills` appearing in the user's tree.
 */
export function spawnSkillsDir(path: string): string {
  return join(spawnDir(path), "skills");
}

function recordPath(path: string): string {
  return join(spawnDir(path), "spawn.json");
}

// Tolerant on read: these files sit in a directory users are invited to inspect, and
// a hand-edited or half-written one must degrade to "no record" rather than take the
// app down on launch. Unknown keys are dropped, not preserved — the shape is ours.
function parse(raw: string): SpawnRecord | null {
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || typeof obj.path !== "string" || !obj.path) return null;
  return {
    path: obj.path,
    model: typeof obj.model === "string" && obj.model.includes("/") ? obj.model : null,
    connectors: Array.isArray(obj.connectors) ? obj.connectors.filter((c: unknown) => typeof c === "string") : [],
    createdAt: Number.isFinite(obj.createdAt) ? obj.createdAt : 0,
    lastOpenedAt: Number.isFinite(obj.lastOpenedAt) ? obj.lastOpenedAt : null,
  };
}

/**
 * The record for `path`, or null if there is none.
 *
 * A record whose stored path disagrees with the folder we asked about is treated as a
 * miss: that is the 64-bit collision case, and answering with another folder's model
 * and connectors would be worse than answering with nothing.
 */
export function readSpawn(path: string): SpawnRecord | null {
  const file = recordPath(path);
  if (!existsSync(file)) return null;
  let rec: SpawnRecord | null;
  try {
    rec = parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!rec) return null;
  return identity(rec.path) === identity(path) ? rec : null;
}

/**
 * Create or update the record for `path` and return the result. Absent fields keep
 * their stored value, so a caller that only knows the model doesn't have to read
 * first and risk clobbering connectors written by another window.
 */
export function writeSpawn(path: string, patch: Partial<Omit<SpawnRecord, "path" | "createdAt">>, now = Date.now()): SpawnRecord {
  const existing = readSpawn(path);
  const next: SpawnRecord = {
    path: resolve(path),
    model: patch.model !== undefined ? patch.model : existing?.model ?? null,
    connectors: patch.connectors !== undefined ? patch.connectors : existing?.connectors ?? [],
    createdAt: existing?.createdAt || now,
    lastOpenedAt: patch.lastOpenedAt !== undefined ? patch.lastOpenedAt : existing?.lastOpenedAt ?? null,
  };
  const dir = spawnDir(path);
  mkdirSync(dir, { recursive: true });
  // 0600 like the rest of the global dir: a record names a folder on this machine
  // and the connectors it runs, which is nobody else's business on a shared box.
  writeFileSync(recordPath(path), JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return next;
}

/** Stamp a spawn as opened now — the roster's "most recent first" ordering. */
export function touchSpawn(path: string, now = Date.now()): SpawnRecord {
  return writeSpawn(path, { lastOpenedAt: now }, now);
}

/**
 * Every record, most recently opened first (never-opened ones last, then by path so
 * the order is stable). Unreadable entries are skipped rather than surfaced as blanks.
 */
export function listSpawns(): SpawnRecord[] {
  const dir = spawnsDir();
  if (!existsSync(dir)) return [];
  let keys: string[];
  try {
    keys = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: SpawnRecord[] = [];
  for (const key of keys) {
    try {
      const rec = parse(readFileSync(join(dir, key, "spawn.json"), "utf8"));
      if (rec) out.push(rec);
    } catch {
      // No record file, or an unreadable one — not a spawn we can offer.
    }
  }
  return out.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || a.path.localeCompare(b.path));
}

/** Drop a folder's record (and its per-spawn skills). True if there was one. */
export function forgetSpawn(path: string): boolean {
  const dir = spawnDir(path);
  if (!existsSync(dir)) return false;
  // Only remove a directory that actually holds THIS folder's record, so a collision
  // (or a stale key) can't delete another spawn's skills.
  if (!readSpawn(path)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
