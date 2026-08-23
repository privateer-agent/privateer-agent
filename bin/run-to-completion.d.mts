// Types for the launcher's child-process handoff. Same reason as update-route.d.mts:
// the implementation is plain .mjs because bin/ runs under a bare `node`, before any
// transpiler exists — but the test that pins the signal behaviour is TypeScript.

import type { SpawnOptions } from "node:child_process";

export interface RunToCompletionOptions extends SpawnOptions {
  /** Pass SIGTERM/SIGHUP on to the child and wait for it, instead of dying alone and
   *  leaving it reparented to init. Off by default — only the long-lived headless
   *  children (harbor, acp) need it; see the implementation's note on why SIGINT and
   *  SIGQUIT are deliberately NOT forwarded. */
  forwardSignals?: boolean;
}

/** Spawn a child and hand it this process's lifetime: its exit code, its signal
 *  death, and — with `forwardSignals` — the termination signals sent to us. Never
 *  returns normally; the process exits with the child. */
export function runToCompletion(cmd: string, cmdArgs: string[], opts?: RunToCompletionOptions): void;
