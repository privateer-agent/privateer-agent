import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { globalDir } from "../config/load.ts";
import { Routine, RoutineFile } from "./schema.ts";

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
    // A corrupt or hand-edited file shouldn't crash the daemon; treat as empty.
    return [];
  }
}

export function saveRoutines(routines: Routine[]): void {
  const dir = globalDir();
  mkdirSync(dir, { recursive: true });
  tryChmod(dir, 0o700);
  const payload: RoutineFile = { routines };
  writeFileSync(routinesFilePath(), JSON.stringify(payload, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  tryChmod(routinesFilePath(), 0o600);
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

// Write a run's result to the routine's output dir: a dated file plus latest.md.
// Returns the absolute path of latest.md.
export function writeRoutineOutput(name: string, content: string): string {
  const dir = routineOutputDir(name);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(dir, `${stamp}.md`), content, "utf8");
  const latest = join(dir, "latest.md");
  writeFileSync(latest, content, "utf8");
  return latest;
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
  writeFileSync(noticesPath(), JSON.stringify(trimmed, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
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
