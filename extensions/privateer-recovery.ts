// Session recovery, agent side — keeps this process's live marker current and, when
// this session is a resumption of one whose agent died, tells the model and the user.
// Also the one place that tells the user when session sealing (bin/session-seal.mjs)
// is off for this run, or when lines of the session couldn't be decrypted.
//
// The marker (bin/session-recovery.mjs has the whole design) is written at:
//   session_start          → which session file, no turn open
//   agent_start            → a turn is open
//   tool_execution_start   → which tool, and a one-line summary of its target
//   tool_execution_end     → no tool running (the turn may still be open)
//   agent_end              → turn closed
//   session_shutdown       → removed, UNLESS a turn is still open — a terminal closed
//                            mid-task is an interrupted task, and the next launch in
//                            that folder should say so
//
// On session_start this agent also looks for a dead agent's marker for the SAME
// session file — handed over by the supervisor in $PRIVATEER_RECOVERY when it
// relaunched us after a crash, or found on disk when the user resumed by hand
// (--session / -c / -r) — and turns it into one note for the model (delivered with
// the user's next message, never triggering a turn on its own) plus one line for
// the user. Nothing is re-run.
//
// TUI only: print/json runs are one-shot and scripted, and the desktop and harbor
// sessions are in-memory, with no session file to resume into.

import fs from "node:fs";
import { globalDir } from "../src/config/paths.ts";
import {
  RECOVERY_ENV,
  decodeRecovery,
  listStale,
  recoveryNote,
  recoveryNotice,
  removeMarker,
  resumeHint,
  staleForSession,
  summarizeToolCall,
  writeMarker,
} from "../bin/session-recovery.mjs";

// Read once and taken out of the environment, like the fresh-agent key: every bash
// command the agent runs inherits process.env, and none of them should see this.
const HANDOFF = Symbol.for("privateer.recovery.handoff");
function takeHandoff(): string | undefined {
  const g = globalThis as any;
  if (!(HANDOFF in g)) {
    g[HANDOFF] = process.env[RECOVERY_ENV];
    delete process.env[RECOVERY_ENV];
  }
  const v = g[HANDOFF];
  g[HANDOFF] = undefined; // one resumption, one note
  return v;
}

let sealingWarned = false;
function sealingNotice(ctx: any): void {
  const g = globalThis as any;
  const codec = g[Symbol.for("privateer.sessionCodec")];
  const error = g[Symbol.for("privateer.sessionCodecError")];
  if (!codec) {
    if (sealingWarned || !error) return; // no preload at all = not launched by privateer
    sealingWarned = true;
    ctx?.ui?.notify?.(`Session encryption is off for this run (${error}). This session is being saved unencrypted. Your key file was left untouched — sessions sealed with it are unreadable until it's fixed.`, "warning");
    return;
  }
  if (codec.failures > 0) {
    const n = codec.failures;
    codec.failures = 0;
    ctx?.ui?.notify?.(`${n} saved line${n === 1 ? "" : "s"} of this session couldn't be decrypted with this machine's session key and ${n === 1 ? "isn't" : "aren't"} shown. The file itself is unchanged.`, "warning");
  }
}

export default function privateerRecovery(pi: any): void {
  const home = globalDir();
  const pid = process.pid;
  let state: {
    sessionFile: string;
    cwd: string;
    startedAt: number;
    turnOpen: boolean;
    tool: { name: string; summary: string; startedAt: number } | null;
  } | null = null;

  const save = () => {
    if (!state) return;
    try {
      writeMarker(home, { v: 1, pid, ...state, updatedAt: Date.now() });
    } catch {
      // A marker we can't write costs only the recovery, never the session.
    }
  };

  pi.on("session_start", (_event: any, ctx: any) => {
    if (ctx?.mode !== "tui") return;
    const sessionFile: string | undefined = ctx?.sessionManager?.getSessionFile?.();
    if (!sessionFile) {
      state = null;
      removeMarker(home, pid);
      return;
    }
    state = { sessionFile, cwd: ctx?.cwd ?? process.cwd(), startedAt: Date.now(), turnOpen: false, tool: null };
    save();

    // Session sealing (bin/session-seal.mjs) is installed by a preload; say when it
    // isn't working rather than let a session silently save in plaintext, or open
    // shorter than it is.
    sealingNotice(ctx);

    // Sessions written before Pi tightened its file mode are world-readable.
    try {
      if (fs.existsSync(sessionFile)) fs.chmodSync(sessionFile, 0o600);
    } catch { /* not ours to fail over */ }

    const handed = decodeRecovery(takeHandoff());
    const dead = handed && handed.sessionFile === sessionFile ? handed : staleForSession(home, sessionFile);
    if (!dead || dead.pid === pid) {
      if (_event?.reason === "startup") hintInterrupted(ctx, sessionFile);
      return;
    }
    removeMarker(home, dead.pid);

    const note = recoveryNote(dead);
    if (note) {
      pi.sendMessage?.(
        { customType: "privateer-recovery", content: note, display: false },
        { deliverAs: "nextTurn" },
      );
    }
    ctx?.ui?.notify?.(recoveryNotice(dead), dead.turnOpen ? "warning" : "info");
  });

  // A NEW session in a folder whose last session died mid-task (the terminal closed,
  // the machine slept and was killed, the supervisor died with it): say how to get it
  // back, once. Never resumed on our own here — the user may have come back on purpose
  // to start something else.
  const hintInterrupted = (ctx: any, current: string) => {
    const cwd = ctx?.cwd ?? process.cwd();
    const m = listStale(home, { cwd }).find((x) => x.turnOpen && !x.hinted && x.sessionFile !== current);
    if (!m) return;
    ctx?.ui?.notify?.(resumeHint(m, { cmd: process.env.PRIVATEER_CMD || "privateer" }), "info");
    try { writeMarker(home, { ...m, hinted: true }); } catch { /* shown once is a nicety */ }
  };

  pi.on("agent_start", () => {
    if (!state) return;
    state.turnOpen = true;
    save();
  });

  pi.on("tool_execution_start", (event: any) => {
    if (!state || event?.parentToolCallId) return; // the outer call is what the user saw
    state.tool = { name: String(event?.toolName ?? "tool"), summary: summarizeToolCall(event?.toolName, event?.args), startedAt: Date.now() };
    save();
  });

  pi.on("tool_execution_end", (event: any) => {
    if (!state || event?.parentToolCallId) return;
    state.tool = null;
    save();
  });

  pi.on("agent_end", () => {
    if (!state) return;
    state.turnOpen = false;
    state.tool = null;
    save();
  });

  pi.on("session_shutdown", () => {
    if (!state) return;
    if (state.turnOpen) save(); // interrupted: leave it for whoever comes next
    else removeMarker(home, pid);
    state = null;
  });
}
