import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "../util/atomicWrite.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { globalDir } from "../config/paths.ts";
import { Routine, RoutineFile } from "./schema.ts";
import type { StagedMedia } from "./resultMedia.ts";

// routines.json lives alongside config.json in the global dir. It can carry the
// prompt text and (for email delivery) recipient hints, so it is written owner-only
// (0600) inside the owner-only global dir, mirroring saveGlobalConfig.
export function routinesFilePath(): string {
  return join(globalDir(), "routines.json");
}

// Per-routine output directory (dated result files + latest.md).
export function routineOutputDir(name: string): string {
  return join(globalDir(), "routines", slug(name));
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "routine";
}

// A stable relay terminal id for the harbor, persisted so it reappears as the same
// "Privateer Local Harbor" terminal in the app across restarts (rather than a fresh
// random terminal each boot). Random on first use so it stays unique per install —
// the relay routes on this id with no user namespacing, so a shared constant could
// collide across accounts. Matches the server's isValidTermId (`[A-Za-z0-9_-]{8,64}`).
export function routineRelayId(): string {
  const path = join(globalDir(), "routines", "relay-id");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  }
  const id = `routines-${randomUUID().replace(/-/g, "")}`;
  const dir = join(globalDir(), "routines");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, id + "\n", { encoding: "utf8", mode: 0o600 });
  tryChmod(path, 0o600);
  return id;
}

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* non-POSIX filesystem or insufficient perms — nothing we can do */
  }
}

export function loadRoutines(): Routine[] {
  const path = routinesFilePath();
  if (!existsSync(path)) return [];
  try {
    return RoutineFile.parse(JSON.parse(readFileSync(path, "utf8"))).routines;
  } catch {
    // A corrupt or hand-edited file shouldn't crash the harbor; treat as empty.
    return [];
  }
}

export function saveRoutines(routines: Routine[]): void {
  const dir = globalDir();
  mkdirSync(dir, { recursive: true });
  tryChmod(dir, 0o700);
  const payload: RoutineFile = { routines };
  // Atomic: a half-written routines.json reads as "no routines" (loadRoutines), and the
  // next save would then persist only the one routine it was given.
  writeFileAtomic(routinesFilePath(), JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
}

// Look up by id first, then by (case-insensitive) name for CLI convenience.
export function findRoutine(routines: Routine[], idOrName: string): Routine | undefined {
  const needle = idOrName.trim().toLowerCase();
  return (
    routines.find((r) => r.id === idOrName) ??
    routines.find((r) => r.name.toLowerCase() === needle)
  );
}

// Insert or replace a routine (matched by id), persisting the whole file.
export function upsertRoutine(routine: Routine): Routine[] {
  const routines = loadRoutines();
  const i = routines.findIndex((r) => r.id === routine.id);
  if (i >= 0) routines[i] = routine;
  else routines.push(routine);
  saveRoutines(routines);
  return routines;
}

// Remove a routine by id or name. Returns the removed routine, or null if absent.
export function removeRoutine(idOrName: string): Routine | null {
  const routines = loadRoutines();
  const target = findRoutine(routines, idOrName);
  if (!target) return null;
  saveRoutines(routines.filter((r) => r.id !== target.id));
  return target;
}

// Dated result files kept per routine. An hourly routine on an always-on box wrote one
// every hour, forever; latest.md is what anything reads, and this many is history enough.
export const ROUTINE_OUTPUT_KEEP = Number(process.env.PRIVATEER_ROUTINE_OUTPUT_KEEP) || 30;

// Write a run's result to the routine's output dir: a dated file plus latest.md, then
// prune the dated files to the newest ROUTINE_OUTPUT_KEEP. Owner-only, like the rest of
// the global dir: a result can quote whatever the routine read.
// Returns the absolute path of latest.md.
export function writeRoutineOutput(name: string, content: string): string {
  const dir = routineOutputDir(name);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(dir, `${stamp}.md`), content, { encoding: "utf8", mode: 0o600 });
  const latest = join(dir, "latest.md");
  writeFileAtomic(latest, content, { mode: 0o600 });
  pruneRoutineOutput(dir, ROUTINE_OUTPUT_KEEP);
  return latest;
}

// Our dated names (ISO with ':' and '.' → '-') sort chronologically as strings, so the
// oldest are first. Only files of that shape are touched — anything else a user put in
// the folder is theirs. Best-effort: a prune failure never fails a delivery.
const DATED_OUTPUT = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.md$/;

export function pruneRoutineOutput(dir: string, keep: number): number {
  let removed = 0;
  try {
    const dated = readdirSync(dir).filter((f) => DATED_OUTPUT.test(f)).sort();
    for (const f of dated.slice(0, Math.max(0, dated.length - keep))) {
      try {
        unlinkSync(join(dir, f));
        removed++;
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* unreadable dir */
  }
  return removed;
}

// A pending routine result queued for the next interactive session ("notice"
// delivery). The TUI drains these on startup so results surface even when no
// terminal was attached at fire time.
export interface RoutineNotice {
  routine: string;
  at: string; // ISO timestamp
  status: "ok" | "error";
  preview: string; // short single-line summary
  path?: string; // latest.md, when file delivery also ran
}

function noticesPath(): string {
  return join(globalDir(), "routines", "notices.json");
}

export function loadNotices(): RoutineNotice[] {
  const path = noticesPath();
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data) ? (data as RoutineNotice[]) : [];
  } catch {
    return [];
  }
}

export function addNotice(notice: RoutineNotice): void {
  const dir = join(globalDir(), "routines");
  mkdirSync(dir, { recursive: true });
  const notices = loadNotices();
  notices.push(notice);
  // Keep the queue bounded so an offline stretch can't grow it without limit.
  const trimmed = notices.slice(-50);
  writeFileAtomic(noticesPath(), JSON.stringify(trimmed, null, 2) + "\n", { mode: 0o600 });
  tryChmod(noticesPath(), 0o600);
}

// Read and clear the notice queue (called by the TUI on startup).
export function drainNotices(): RoutineNotice[] {
  const notices = loadNotices();
  if (notices.length === 0) return [];
  try {
    writeFileSync(noticesPath(), "[]\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    /* best-effort clear */
  }
  return notices;
}

// A relay result produced while no controller was attached, held until the app
// next connects. Persisted (not just in-memory) so it survives a harbor restart.
export interface PendingRelay {
  routine: string;
  at: string; // ISO timestamp
  content: string;
}

function pendingRelayPath(): string {
  return join(globalDir(), "routines", "pending-relay.json");
}

export function loadPendingRelay(): PendingRelay[] {
  const path = pendingRelayPath();
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data) ? (data as PendingRelay[]) : [];
  } catch {
    return [];
  }
}

export function addPendingRelay(entry: PendingRelay): void {
  const dir = join(globalDir(), "routines");
  mkdirSync(dir, { recursive: true });
  const queue = loadPendingRelay();
  queue.push(entry);
  const trimmed = queue.slice(-50); // bound the backlog
  writeFileAtomic(pendingRelayPath(), JSON.stringify(trimmed, null, 2) + "\n", { mode: 0o600 });
  tryChmod(pendingRelayPath(), 0o600);
}

// Read and clear the pending-relay queue (called when a controller attaches).
export function drainPendingRelay(): PendingRelay[] {
  const queue = loadPendingRelay();
  if (queue.length === 0) return [];
  try {
    writeFileSync(pendingRelayPath(), "[]\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    /* best-effort clear */
  }
  return queue;
}

// What produced a result delivered to the account outbox. Travels inside the sealed
// envelope, so the app can label and filter its inbox without the server learning
// anything. Kept here (not in the harbor) because the pending-cloud queue persists it.
export type OutboxKind = "routine" | "task" | "workflow";

// A `cloud`-delivery result that couldn't be sealed+posted to the account outbox
// yet (offline, server down, or the app hasn't published its outbox key). Held on
// disk until a later flush succeeds. Unlike PendingRelay this carries `status`, so
// the sealed envelope the app opens can render ok/error without re-parsing markdown.
export interface PendingCloud {
  routine: string; // the routine name OR ad-hoc task title (see `kind`)
  at: string; // ISO timestamp
  status: "ok" | "error";
  content: string;
  // What produced this — a scheduled routine (default, for back-compat with items
  // written before ad-hoc tasks existed), an app-submitted one-shot task, or a
  // workflow run. Preserved so the flush re-seals with the right `kind` and the app
  // labels it correctly in the inbox.
  kind?: OutboxKind;
  // Attachments the run staged for the Inbox (resultMedia.ts) — RECORDS, not bytes.
  // The files are still on this machine, so a flush hours later re-reads them from
  // these paths; one that has since been deleted is named in the delivered body
  // instead. Copying megabytes into this queue would be the same content twice on
  // the one box that already has it.
  media?: StagedMedia[];
  // What the run was asked to do (outbox/cloudOutbox.ts OutboxSource), so a flush
  // hours later still seals the context a follow-up needs. Structurally typed rather
  // than imported: this module is the queue's shape, and cloudOutbox already imports
  // from here (importing back would make the cycle).
  source?: {
    routineId?: string;
    prompt?: string;
    cwd?: string;
    model?: string;
    schedule?: string;
  };
}

function pendingCloudPath(): string {
  return join(globalDir(), "routines", "pending-cloud.json");
}

export function loadPendingCloud(): PendingCloud[] {
  const path = pendingCloudPath();
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data) ? (data as PendingCloud[]) : [];
  } catch {
    return [];
  }
}

export function addPendingCloud(entry: PendingCloud): void {
  const dir = join(globalDir(), "routines");
  mkdirSync(dir, { recursive: true });
  const queue = loadPendingCloud();
  queue.push(entry);
  savePendingCloud(queue.slice(-50)); // bound the backlog
}

// Overwrite the queue wholesale — used by the flush to drop the items it managed
// to post while keeping the ones that still failed (and their order).
export function savePendingCloud(entries: PendingCloud[]): void {
  const dir = join(globalDir(), "routines");
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(pendingCloudPath(), JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
  tryChmod(pendingCloudPath(), 0o600);
}
