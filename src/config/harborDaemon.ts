// "Am I running inside the harbor daemon?" — a process-level marker, set once by
// Harbor.start() and read by code that must behave differently there.
//
// The harbor daemon shares ~/.privateer/agent with the interactive TUI, so Pi
// auto-discovers the shipped TUI extensions (extensions/*.ts shims installed by
// bin/privateer-launch.mjs) into every session the daemon creates. Most of that is
// harmless, but the gate extension also registers the relay file tools against ITS
// module-level bridge — the one only `/remote-access` ever attaches a relay to. In the
// daemon that bridge is permanently unattached, and because Pi resolves duplicate tool
// names first-registration-wins (discovered extensions load before inline factories), it
// would shadow the session-scoped pair a live task registers against its own live relay.
// So the gate stands its file tools down here and each daemon session registers its own
// (see src/tools/relayFileTools.ts, src/remote/liveTaskSession.ts).
//
// An env var rather than a module singleton on purpose: discovered extensions are loaded
// through jiti with its module cache off, so they may hold a SEPARATE copy of our modules.
// process.env is the one piece of state both copies are guaranteed to share.
//
// IMPORT-SAFETY: no Pi imports, no node builtins — safe to load from anywhere.

const ENV = "PRIVATEER_HARBOR_DAEMON";

/** Called once by the daemon as it starts. Idempotent. */
export function markHarborDaemon(): void {
  process.env[ENV] = "1";
}

/** True inside the harbor daemon process (routines, workflows, tasks, live spawns). */
export function inHarborDaemon(): boolean {
  return process.env[ENV] === "1";
}
