// Which account-provider inference sessions this machine has spawned, and which
// terminal owns each one.
//
// The problem this solves: every launch used to spawn a NEW server-side session, and
// only a CLEAN exit revoked it (session_shutdown → revokeLocalSessions). A terminal
// that dies without running its shutdown hook — SIGKILL, a closed window, a crash,
// `kill` — leaves its session row alive server-side for the rest of its ~24h TTL. Do
// that a few times and the next spawn is refused with
// `429 CHILD_SESSION_CAP: Too many active terminals for this device`, which takes the
// whole account channel down until the rows age out.
//
// The fix is to reclaim an orphan instead of stacking another row on top of it. That
// needs one bit the credential itself can't tell us: is the terminal that owns it
// still RUNNING? A live terminal's session must never be touched — adopting it rotates
// its refresh token out from under it and kills a working session (they rotate in
// isolation, one per terminal, by design). So each entry records the owning pid, and
// a session counts as orphaned only once that pid is gone.
//
// pid liveness is signal-0. The failure mode is asymmetric and we lean on that: a
// RECYCLED pid makes a dead owner look alive, so we skip a reclaimable session and
// spawn a fresh one — the old behaviour, no harm. The dangerous direction (a live
// process reported dead) can't happen: a running pid never reports ESRCH.

import { existsSync, mkdirSync, readFileSync, rmSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { accountSessionsPath, globalDir } from "../config/paths.ts";

// One spawned session, keyed in the file by the pid of its owning terminal. `refresh`
// is what lets a later launch adopt or revoke it; `expires` is its access token's exp
// (see jwtExpMs), used only to prune entries that are dead server-side anyway.
export interface OwnedSession {
  pid: number;
  refresh: string;
  expires: number;
}

type Registry = Record<string, { refresh?: unknown; expires?: unknown }>;

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* best effort — a restrictive umask or an odd filesystem */
  }
}

function readRegistry(): Registry {
  const path = accountSessionsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Registry) : {};
  } catch {
    return {}; // corrupt/truncated — start clean rather than wedging every launch
  }
}

// Write via temp + rename so a concurrent reader never sees a half-written file. Two
// terminals racing can still lose one entry (last writer wins); the cost is one
// unreclaimable orphan, not a broken launch, so a lock file isn't worth it here.
function writeRegistry(reg: Registry): void {
  const path = accountSessionsPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    tryChmod(globalDir(), 0o700);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    tryChmod(tmp, 0o600);
    renameSync(tmp, path);
  } catch {
    /* best effort — losing the registry costs reclamation, never correctness */
  }
}

// Is a pid still running? EPERM means it exists but belongs to another user, which is
// still "alive" — and alive is the safe answer (we skip reclamation rather than risk
// hijacking a live terminal's session).
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseEntry(pid: string, raw: { refresh?: unknown; expires?: unknown }): OwnedSession | null {
  const n = Number(pid);
  if (!Number.isInteger(n) || typeof raw?.refresh !== "string" || !raw.refresh) return null;
  return { pid: n, refresh: raw.refresh, expires: typeof raw.expires === "number" ? raw.expires : 0 };
}

// Claim (or re-claim) a session for THIS process. Called wherever the account
// credential is minted or rotated — spawnAccountCredentials and
// refreshAccountCredentials — so the registry always holds the token that would
// actually work, including the rotations Pi drives on its own.
export function recordOwnedSession(cred: { refresh: string; expires: number }): void {
  const reg = readRegistry();
  reg[String(process.pid)] = { refresh: cred.refresh, expires: cred.expires };
  writeRegistry(reg);
}

// Drop this process's entry — the session is being revoked (clean exit, /signout), so
// it is about to stop existing server-side. Leaving it behind would advertise a dead
// session as a reclaimable orphan to the next launch.
export function forgetOwnedSession(): void {
  const reg = readRegistry();
  if (!(String(process.pid) in reg)) return;
  delete reg[String(process.pid)];
  writeRegistry(reg);
}

// Sessions whose owning terminal is gone: candidates to adopt or revoke. Prunes
// entries that are unusable anyway (malformed, or past their expiry) as a side
// effect, so the file can't grow without bound. Our own pid is never a candidate.
export function orphanedSessions(now = Date.now()): OwnedSession[] {
  const reg = readRegistry();
  const orphans: OwnedSession[] = [];
  let pruned = false;

  for (const [pid, raw] of Object.entries(reg)) {
    const entry = parseEntry(pid, raw);
    if (!entry || (entry.expires > 0 && entry.expires <= now)) {
      delete reg[pid]; // malformed, or dead server-side — nothing to reclaim
      pruned = true;
      continue;
    }
    if (entry.pid === process.pid || isAlive(entry.pid)) continue; // ours, or a live terminal's
    orphans.push(entry);
  }

  if (pruned) writeRegistry(reg);
  return orphans;
}

// Forget one orphan, once it has been definitively handled (adopted, or confirmed dead
// server-side). A entry whose refresh merely FAILED TO REACH the server is deliberately
// kept: dropping it on a network blip would leak that row until its TTL.
export function dropOwnedSession(pid: number): void {
  const reg = readRegistry();
  if (!(String(pid) in reg)) return;
  delete reg[String(pid)];
  writeRegistry(reg);
}

// Test seam: wipe the registry file.
export function clearOwnedSessions(): void {
  try {
    rmSync(accountSessionsPath(), { force: true });
  } catch {
    /* nothing to remove */
  }
}
