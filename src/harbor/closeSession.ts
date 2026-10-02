// Tear a headless session all the way down. dispose() alone stops the agent but never
// emits session_shutdown — that is AgentSessionRuntime's job, and we build sessions
// without one — so every extension that cleans up on it (pi-mcp-adapter's connections,
// OAuth runtime and lifecycle state among them) leaked once per run, for the life of a
// resident process. Reason "new", not "quit": to our own extensions "quit" means the
// PROCESS is exiting (privateer-brand revokes the machine's sessions on it), and the
// harbor process lives on. Best-effort: teardown must never fail a finished run.
export async function closeSession(session: any): Promise<void> {
  try {
    const runner = session?.extensionRunner;
    if (runner?.hasHandlers?.("session_shutdown")) await runner.emit({ type: "session_shutdown", reason: "new" });
  } catch {
    /* a handler threw — dispose anyway */
  }
  try {
    session?.dispose?.();
  } catch {
    /* already disposed */
  }
}
