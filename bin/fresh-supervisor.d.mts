// Types for the fresh-agent supervisor. Same reason as run-to-completion.d.mts: bin/
// runs under a bare `node` before any transpiler exists, but the /fresh extension and
// the tests that pin the reaping and arg-filtering are TypeScript.

export const FRESH_GRACE_MS: number;
export const FRESH_SOCKET_ENV: "PRIVATEER_FRESH_SOCKET";
export const FRESH_TOKEN_ENV: "PRIVATEER_FRESH_TOKEN";

export interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
}

/** A supervised terminal, as registered in PRIVATEER_HOME/run/<pid>.json. */
export interface TerminalEntry {
  pid: number;
  childPid?: number;
  socket: string;
  token: string;
  cwd: string;
  startedAt: number;
}

export function parsePs(text: string): PsRow[];
/** The root, its descendants, and every member of a group a descendant leads —
 *  never the supervisor's own group (`protectPgid`) as a group. */
export function collectTree(rows: PsRow[], rootPid: number, protectPgid?: number): { pids: number[]; groups: number[] };
/** The user's launch args minus session selection, the initial prompt and @files. */
export function filterRespawnArgs(args: string[]): string[];
export function runDir(home: string): string;
export function listTerminals(home: string): TerminalEntry[];
export function requestFresh(socket: string, token: string, timeoutMs?: number): Promise<{ ok: true; pid: number }>;
/** Run the TUI under supervision; `buildArgs(true)` for the first launch, false after. */
export function runSupervised(cmd: string, buildArgs: (first: boolean) => string[], opts: { home: string }): void;
