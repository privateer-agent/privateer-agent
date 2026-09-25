// /fresh — replace this agent with a brand-new one, in the same terminal.
//
// Not /new. Pi's /new starts a new session inside THIS process: whatever has wedged,
// leaked or been left running (a dev server, a watcher, a subagent) comes along. /fresh
// asks the launcher above us (bin/fresh-supervisor.mjs) to stop this process and every
// process it started, then boot a new agent with a new session and nothing linking it
// to this one. The session file stays on disk, so /resume can still bring it back.
//
// It runs immediately, with no confirmation, because nothing is lost that /resume
// can't bring back — except the processes it reaps, which is the point.
//
// Only a terminal started by `privateer` has a supervisor. The desktop app, the harbor,
// ACP and subagent children don't, and they say so instead of failing quietly. A jammed
// agent can't run this at all — its event loop is the thing that's stuck — which is
// what `privateer fresh` from another terminal is for.
//
// Voice: extensions/privateer-speak.ts maps a few spoken phrases ("fresh start", …)
// onto this command.

import { FRESH_SOCKET_ENV, FRESH_TOKEN_ENV, requestFresh } from "../bin/fresh-supervisor.mjs";

// Read once, then taken out of this process's environment: every bash command and
// subagent the agent runs inherits process.env, and none of them has any business
// holding the key that restarts this terminal (and kills whatever it's running).
// Kept on globalThis rather than in a module variable because /reload and a new
// session re-run this factory, possibly through a fresh module instance, and by then
// the environment no longer has it.
const KEY = Symbol.for("privateer.fresh.launcher");
function launcherKey(): { socket?: string; token?: string } {
  const g = globalThis as any;
  if (!g[KEY]) {
    g[KEY] = { socket: process.env[FRESH_SOCKET_ENV], token: process.env[FRESH_TOKEN_ENV] };
    delete process.env[FRESH_SOCKET_ENV];
    delete process.env[FRESH_TOKEN_ENV];
  }
  return g[KEY];
}

export default function privateerFresh(pi: any): void {
  const { socket, token } = launcherKey();

  pi.registerCommand?.("fresh", {
    description: "Replace this agent with a new one — stops everything it started, keeps the session for /resume",
    handler: async (_args: string, ctx: any) => {
      const notify = (m: string, kind: "info" | "warning" | "error" = "info") => ctx?.ui?.notify?.(m, kind);
      if (!socket || !token) {
        notify("/fresh needs a terminal started with `privateer` — this session has no launcher to hand over to. /new starts a new session in place.", "warning");
        return;
      }
      notify("Starting a fresh agent…");
      try {
        await requestFresh(socket, token);
        // The launcher now stops this process; nothing more to do here.
      } catch (e) {
        notify(`Couldn't reach the launcher (${e instanceof Error ? e.message : String(e)}). /new starts a new session in place.`, "error");
      }
    },
  });
}
