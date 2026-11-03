// Session recovery — what lets a terminal survive its agent dying mid-task.
//
// Pi already writes the session to disk as it goes (~/.privateer/agent/sessions,
// one JSONL file per session, the user's prompt persisted BEFORE the first reply),
// and it already patches a tool call that never got a result ("No result
// provided"). What nothing did was notice the death and act on it:
//   - an uncaught exception was logged (crashes.json) and the next launch said
//     "Run /bug" — it never offered the session back;
//   - SIGKILL, the OOM killer, a closed terminal or a power cut left no trace at all;
//   - a resumed session gave the model no hint that its last tool may have half-run.
//
// So each agent process keeps a LIVE MARKER (run/live/<pid>.json, 0600): which
// session file it is in, whether a turn is open, and which tool is running. The
// agent writes it (extensions/privateer-recovery.ts); whoever outlives the agent
// reads it:
//   - the supervisor (fresh-supervisor.mjs), when its child dies like a crash,
//     relaunches into the same session at once;
//   - the launcher, on the next `privateer` in that folder, prints how to resume a
//     session that died with a turn open (it never resumes on its own there — the
//     user may have come back to start something new);
//   - the resumed agent turns the marker into ONE note for the model: the previous
//     process stopped during `<tool>`, the work may be partly applied, check before
//     continuing. Never an automatic re-run: replaying `git push` or a migration is
//     worse than losing the turn.
//
// A marker is removed when the agent shuts down cleanly with NO turn open. A
// graceful shutdown with a turn open (the terminal closed, SIGTERM) leaves it: the
// work was interrupted all the same.
//
// Dependency-free on purpose: the launcher reads this before anything is patched,
// and the supervisor runs it with no TS loader.

import fs from "node:fs";
import path from "node:path";

export const RECOVERY_ENV = "PRIVATEER_RECOVERY";

/** Markers older than this are garbage: nobody is coming back for that turn. */
export const MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Auto-resume at most this many times… */
export const RESUME_BUDGET = 2;
/** …within this window, so a session that crashes on load can't loop forever. */
export const RESUME_WINDOW_MS = 3 * 60 * 1000;

// Deaths that look like the process failing rather than being asked to stop.
// SIGKILL is in: it is what the OOM killer sends. SIGINT/SIGTERM/SIGHUP are not —
// those are a person, a terminal or a service manager saying stop.
const CRASH_SIGNALS = new Set(["SIGKILL", "SIGSEGV", "SIGABRT", "SIGBUS", "SIGILL", "SIGFPE", "SIGTRAP"]);
// Exit codes that mean "stopped on request" (128 + SIGINT / SIGTERM / SIGHUP).
const REQUESTED_CODES = new Set([0, 129, 130, 143]);

export function liveDir(home) {
  return path.join(home, "run", "live");
}

export function markerPath(home, pid) {
  return path.join(liveDir(home), `${pid}.json`);
}

/** Write atomically (tmp + rename) and owner-only: it names files and commands. */
export function writeMarker(home, marker) {
  const dir = liveDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = markerPath(home, marker.pid);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marker) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readMarker(home, pid) {
  return parseMarker(safeRead(markerPath(home, pid)));
}

export function removeMarker(home, pid) {
  try {
    fs.rmSync(markerPath(home, pid), { force: true });
  } catch {
    /* best-effort */
  }
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Shape-check a marker. Anything malformed reads as absent, never as a crash. */
export function parseMarker(text) {
  if (typeof text !== "string") return null;
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!m || m.v !== 1 || !Number.isInteger(m.pid) || typeof m.sessionFile !== "string" || !m.sessionFile) return null;
  return {
    v: 1,
    pid: m.pid,
    sessionFile: m.sessionFile,
    cwd: typeof m.cwd === "string" ? m.cwd : "",
    startedAt: Number(m.startedAt) || 0,
    updatedAt: Number(m.updatedAt) || 0,
    turnOpen: m.turnOpen === true,
    tool: m.tool && typeof m.tool.name === "string"
      ? { name: m.tool.name, summary: typeof m.tool.summary === "string" ? m.tool.summary : "", startedAt: Number(m.tool.startedAt) || 0 }
      : null,
    hinted: m.hinted === true,
  };
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/**
 * Markers whose agent died MID-TURN, newest first. Prunes the rest of the dead: idle
 * ones, ones past MARKER_MAX_AGE_MS, and ones whose session file is gone.
 */
export function listStale(home, { cwd, now = Date.now(), alive = isAlive } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(liveDir(home)).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(liveDir(home), name);
    const m = parseMarker(safeRead(file));
    if (!m) continue;
    if (alive(m.pid)) continue;
    // Dead while IDLE says nothing worth saying (a closed terminal can kill Pi on its
    // dead-tty path, which skips session_shutdown, so these do happen). The
    // supervisor's crash resume reads its child's marker directly, not through here.
    if (!m.turnOpen || now - (m.updatedAt || m.startedAt) > MARKER_MAX_AGE_MS || !fs.existsSync(m.sessionFile)) {
      try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
      continue;
    }
    if (cwd && path.resolve(m.cwd) !== path.resolve(cwd)) continue;
    out.push(m);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The stale marker (if any) for one session file — what a resumed agent consumes. */
export function staleForSession(home, sessionFile, opts = {}) {
  const want = path.resolve(sessionFile);
  return listStale(home, opts).find((m) => path.resolve(m.sessionFile) === want) ?? null;
}

/**
 * Should the supervisor relaunch into the session right now? Pure.
 * `restarts` = timestamps of earlier auto-resumes by this supervisor.
 */
// There is deliberately no minimum-lifetime floor. The marker is written only once a
// session has LOADED (session_start), so an agent that crashes while booting or while
// loading the session has no marker and is never resumed — that, plus the budget, is
// the loop guard. A 5s floor was tried and wrongly refused a real kill -9 of a warm
// agent that had been up for 3s.
export function shouldAutoResume({ code, signal, marker, restarts = [], now = Date.now(), sessionExists = true, interactive = true }) {
  if (!marker || !interactive || !sessionExists) return false;
  const crashed = signal ? CRASH_SIGNALS.has(signal) : !REQUESTED_CODES.has(code ?? 0);
  if (!crashed) return false;
  return restarts.filter((t) => now - t < RESUME_WINDOW_MS).length < RESUME_BUDGET;
}

/** One line describing a tool call, safe to keep in a 0600 file and show the model. */
export function summarizeToolCall(name, args) {
  const flat = (s) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const clip = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  if (!args || typeof args !== "object") return clip(flat(name));
  const pick = args.command ?? args.cmd ?? args.path ?? args.file_path ?? args.file ?? args.url ?? args.query;
  if (typeof pick === "string" && pick.trim()) return clip(flat(pick));
  return clip(Object.keys(args).slice(0, 6).join(", "));
}

const ago = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return "moments ago";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

/** The note the resumed agent hands the model. Null when no turn was open. */
export function recoveryNote(marker, { reason = "stopped unexpectedly" } = {}) {
  if (!marker?.turnOpen) return null;
  const during = marker.tool
    ? `while it was running the \`${marker.tool.name}\` tool${marker.tool.summary ? ` (\`${marker.tool.summary}\`)` : ""}`
    : "in the middle of a turn, between tool calls";
  return [
    `[Privateer] The previous agent process for this session ${reason} ${during}.`,
    "Its last action may have run fully, partly, or not at all, and anything it started (a server, a build, a migration) may still be running or may have been killed.",
    "Do not repeat that action blindly. Check the current state first (files, git status, running processes, the remote) and tell the user briefly what you found before carrying on.",
  ].join(" ");
}

/** What the user sees in the resumed terminal. */
export function recoveryNotice(marker, { now = Date.now() } = {}) {
  const when = ago(now - (marker.updatedAt || marker.startedAt || now));
  if (!marker.turnOpen) return `Resumed your session — the previous agent stopped ${when}.`;
  const what = marker.tool ? ` during ${marker.tool.name}${marker.tool.summary ? `: ${marker.tool.summary}` : ""}` : "";
  return `Resumed your session — the previous agent stopped ${when} mid-task${what}. It may have been partly done; the agent will check before continuing.`;
}

/** Pi's session id from its file name (`<timestamp>_<id>.jsonl`). */
export function sessionIdFromFile(file) {
  const m = path.basename(file).match(/_([0-9a-f-]{8,})\.jsonl$/i);
  return m ? m[1] : null;
}

/** Copy-pasteable resume hint for the next launch in that folder. */
export function resumeHint(marker, { cmd = "privateer", now = Date.now() } = {}) {
  const id = sessionIdFromFile(marker.sessionFile);
  const target = id ?? marker.sessionFile;
  const what = marker.tool ? ` (during ${marker.tool.name}${marker.tool.summary ? `: ${marker.tool.summary}` : ""})` : "";
  return `⚓ Your last session in this folder stopped mid-task ${ago(now - (marker.updatedAt || now))}${what}.\n   Resume it: ${cmd} --session ${target}`;
}

/** Encode a marker for the relaunched child's environment (and decode it there). */
export function encodeRecovery(marker) {
  return Buffer.from(JSON.stringify(marker)).toString("base64");
}
export function decodeRecovery(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return parseMarker(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
