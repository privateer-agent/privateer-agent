// Which account-provider inference sessions this machine has spawned, and which
// terminal owns each one.
//
// The problem this solves: every launch used to spawn a NEW server-side session, and
// only a CLEAN exit revoked it (session_shutdown → revokeLocalSessions). A terminal
// that dies without running its shutdown hook — SIGKILL, a closed window, a crash,
// `kill` — leaves its session row alive server-side for the rest of its ~24h TTL. Do
// that a few times and the account accumulates a pile of live rows nobody owns. (There
// used to be a per-device cap that refused the next spawn outright, which took the whole
// account channel down until the rows aged out; it is gone, and this is what keeps the
// row count sane without one.)
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
//
// LAYOUT — one file per owning pid (`<pid>.json` in accountSessionsDir), and an orphan
// is CLAIMED by renaming its file before anyone rotates it. This used to be a single
// JSON file that every process read, modified and wrote back whole, and that was a real
// outage under concurrency (an agent firing several `privateer -p` one-shots at once):
//
//   A reads {orphan: R}  ·  B reads {orphan: R}  ·  B adopts the orphan (R → R′) and
//   writes it out  ·  A writes ITS stale copy back, orphan entry and all.
//
// The resurrected entry names a refresh token that was already rotated. The next launch
// "reclaims" it, the server sees a spent token replayed past its 30s grace window, calls
// it theft, and revokes the whole lineage — which is the session B (or whoever adopted
// down the chain) is using right now, and possibly the one in the shared auth.json that
// other running terminals read. They all 401 mid-run, and a one-shot run has no next
// message to recover on, so the user is told to /login while signed in.
//
// Per-pid files mean no process ever writes another's entry, and rename is atomic on
// every platform we ship on, so exactly one claimer wins an orphan and the rest get
// ENOENT and move on. A claim whose claimant died is deleted rather than released: its
// token may already have been rotated, and offering it again is the same hazard.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { accountSessionsDir, accountSessionsPath, globalDir } from "../config/paths.ts";

// One spawned session, keyed by the pid of its owning terminal. `refresh` is what lets
// a later launch adopt or revoke it; `expires` is its access token's exp (see
// jwtExpMs), used only to prune entries that are dead server-side anyway.
export interface OwnedSession {
  pid: number;
  refresh: string;
  expires: number;
}

const ENTRY = /^(\d+)\.json$/;
const CLAIM = /^(\d+)\.claim-(\d+)$/;

function entryPath(pid: number): string {
  return join(accountSessionsDir(), `${pid}.json`);
}

function claimPath(pid: number, claimant = process.pid): string {
  return join(accountSessionsDir(), `${pid}.claim-${claimant}`);
}

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* best effort — a restrictive umask or an odd filesystem */
  }
}

function tryRm(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* already gone, or unremovable — nothing more to do */
  }
}

function readEntry(path: string, pid: number): OwnedSession | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { refresh?: unknown; expires?: unknown };
    if (typeof raw?.refresh !== "string" || !raw.refresh) return null;
    return { pid, refresh: raw.refresh, expires: typeof raw.expires === "number" ? raw.expires : 0 };
  } catch {
    return null; // corrupt/truncated — treated as malformed and pruned
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

// Claim (or re-claim) a session for THIS process. Called wherever the account
// credential is minted or rotated — spawnAccountCredentials and
// refreshAccountCredentials — so the registry always holds the token that would
// actually work, including the rotations Pi drives on its own. Written via temp +
// rename so a concurrent reader never sees a half-written file.
export function recordOwnedSession(cred: { refresh: string; expires: number }): void {
  try {
    mkdirSync(accountSessionsDir(), { recursive: true });
    tryChmod(globalDir(), 0o700);
    tryChmod(accountSessionsDir(), 0o700);
    const path = entryPath(process.pid);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ refresh: cred.refresh, expires: cred.expires }) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    tryChmod(tmp, 0o600);
    renameSync(tmp, path);
  } catch {
    /* best effort — losing the registry costs reclamation, never correctness */
  }
}

// Drop this process's entry — the session is being revoked (clean exit, /signout), so
// it is about to stop existing server-side. Leaving it behind would advertise a dead
// session as a reclaimable orphan to the next launch.
export function forgetOwnedSession(): void {
  tryRm(entryPath(process.pid));
}

// Sessions whose owning terminal is gone: candidates to adopt or revoke. Listing is NOT
// claiming — call claimOrphan before rotating one. Prunes entries that are unusable
// anyway (malformed, or past their expiry) and claims left by a dead claimant, so the
// directory can't grow without bound. Our own pid is never a candidate.
export function orphanedSessions(now = Date.now()): OwnedSession[] {
  let names: string[];
  try {
    names = readdirSync(accountSessionsDir());
  } catch {
    return []; // no registry yet
  }
  const orphans: OwnedSession[] = [];
  for (const name of names) {
    const path = join(accountSessionsDir(), name);
    const claim = CLAIM.exec(name);
    if (claim) {
      // Mid-adoption by a live process: theirs. Claimant died: its token may already
      // be rotated, so it is junk — never put back up for reclamation.
      if (!isAlive(Number(claim[2]))) tryRm(path);
      continue;
    }
    const m = ENTRY.exec(name);
    if (!m) continue; // a temp file mid-write, or something that isn't ours
    const pid = Number(m[1]);
    if (pid === process.pid || isAlive(pid)) continue; // ours, or a live terminal's
    const entry = readEntry(path, pid);
    if (!entry || (entry.expires > 0 && entry.expires <= now)) {
      tryRm(path); // malformed, or dead server-side — nothing to reclaim
      continue;
    }
    orphans.push(entry);
  }
  return orphans;
}

// Take an orphan for THIS process, atomically. True only for the one caller whose rename
// landed; everyone else racing for the same orphan gets false and must leave it alone.
// Pair with dropOwnedSession (handled) or releaseOrphan (couldn't reach the server).
export function claimOrphan(pid: number): boolean {
  try {
    renameSync(entryPath(pid), claimPath(pid));
    return true;
  } catch {
    return false;
  }
}

// Put back an orphan we claimed but couldn't settle: its refresh never reached the
// server, so the token is still the live one and the row is still worth reclaiming.
export function releaseOrphan(pid: number): void {
  try {
    renameSync(claimPath(pid), entryPath(pid));
  } catch {
    tryRm(claimPath(pid));
  }
}

// Forget one orphan, once it has been definitively handled (adopted, or confirmed dead
// server-side). An entry whose refresh merely FAILED TO REACH the server goes back via
// releaseOrphan instead: dropping it on a network blip would leak that row until its TTL.
export function dropOwnedSession(pid: number): void {
  tryRm(claimPath(pid));
  if (pid !== process.pid) tryRm(entryPath(pid));
}

// Wipe the registry. Used by logout(), where the server has just revoked this
// machine's whole token family: every entry now names a dead session, and leaving
// them behind would offer the next login a list of orphans to "reclaim" that can
// only fail. Also removes the legacy single-file registry. Also a test seam.
export function clearOwnedSessions(): void {
  tryRm(accountSessionsPath());
  try {
    if (existsSync(accountSessionsDir())) rmSync(accountSessionsDir(), { recursive: true, force: true });
  } catch {
    /* nothing to remove */
  }
}
