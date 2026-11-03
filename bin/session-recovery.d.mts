// Types for session recovery (bin/session-recovery.mjs). Same reason as the other
// bin/*.d.mts: bin/ runs under a bare `node`, but the recovery extension and its tests
// are TypeScript.

export const RECOVERY_ENV: "PRIVATEER_RECOVERY";
export const MARKER_MAX_AGE_MS: number;
export const RESUME_BUDGET: number;
export const RESUME_WINDOW_MS: number;

export interface MarkerTool {
  name: string;
  summary: string;
  startedAt: number;
}

/** A live marker, as kept in PRIVATEER_HOME/run/live/<pid>.json. */
export interface LiveMarker {
  v: 1;
  pid: number;
  sessionFile: string;
  cwd: string;
  startedAt: number;
  updatedAt: number;
  turnOpen: boolean;
  tool: MarkerTool | null;
  hinted?: boolean;
}

export function liveDir(home: string): string;
export function markerPath(home: string, pid: number): string;
export function writeMarker(home: string, marker: Omit<LiveMarker, "v"> & { v: 1 } | LiveMarker): void;
export function readMarker(home: string, pid: number): LiveMarker | null;
export function removeMarker(home: string, pid: number): void;
export function parseMarker(text: string | null): LiveMarker | null;
export function isAlive(pid: number): boolean;
export function listStale(home: string, opts?: { cwd?: string; now?: number; alive?: (pid: number) => boolean }): LiveMarker[];
export function staleForSession(home: string, sessionFile: string, opts?: { now?: number; alive?: (pid: number) => boolean }): LiveMarker | null;
export function shouldAutoResume(input: {
  code: number | null;
  signal: string | null;
  marker: LiveMarker | null;
  restarts?: number[];
  now?: number;
  sessionExists?: boolean;
  interactive?: boolean;
}): boolean;
export function summarizeToolCall(name: unknown, args: unknown): string;
export function recoveryNote(marker: LiveMarker | null, opts?: { reason?: string }): string | null;
export function recoveryNotice(marker: LiveMarker, opts?: { now?: number }): string;
export function sessionIdFromFile(file: string): string | null;
export function resumeHint(marker: LiveMarker, opts?: { cmd?: string; now?: number }): string;
export function encodeRecovery(marker: LiveMarker): string;
export function decodeRecovery(value: string | undefined | null): LiveMarker | null;
