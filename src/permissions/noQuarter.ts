// No-quarter: the moat fully lowered for a session — every action auto-approves
// with no prompt (dangerous shell, destructive tools, out-of-cwd, protected files).
// This is the single source of truth for that state; the gate reads it through
// ModeGate.getSkipAllPermissions, which sits above every other policy check.
//
// Two ways in, one state:
//   1. `privateer --no-quarter` at launch → PRIVATEER_NO_QUARTER=1 (see
//      bin/privateer-launch.mjs), which is what the reader below sees.
//   2. shift+tab in a live session → toggleNoQuarter(). This is the "step away from
//      the keyboard" switch: flip it on and the agent runs to completion instead of
//      stopping on the next approval prompt.
//
// THE ENV VAR IS THE STORE, not a mirror of a module-level flag — and that is
// load-bearing for two separate reasons:
//
//   • ACROSS PROCESSES: a pi-subagents child is a `pi` subprocess that inherits this
//     process's env and reads PRIVATEER_NO_QUARTER in its own gate. Children spawned
//     after a toggle therefore match the parent; ones already running keep the posture
//     they started with.
//   • ACROSS EXTENSIONS IN THIS PROCESS: Pi loads each extension with its OWN jiti
//     instance and `moduleCache: false` (pi-coding-agent dist/core/extensions/loader.ts,
//     loadExtensionModule), so every extension that imports this file gets a SEPARATE
//     copy of it. A module-level `let` would be per-extension state: shift+tab in
//     extensions/privateer-gate.ts flipped the gate's copy while the copy inside
//     extensions/privateer-privacy.ts stayed false, so a no-quarter session still
//     stopped the turn with pi-privacy's "PII detected — send as-is or redact?" prompt.
//     process.env is the one thing all those copies share, so the state lives there and
//     nowhere else: every reader, in every extension, sees every toggle.
//
// IMPORT-SAFETY: no Pi imports, no node builtins — safe to load from anywhere,
// including boot-ordered entrypoints (see boot.ts's ORDERING CONTRACT).

const ENV = "PRIVATEER_NO_QUARTER";

/** True while the gate is fully lowered for this session. Read live, never cached. */
export function noQuarterActive(): boolean {
  return process.env[ENV] === "1";
}

/** Set the state — in the env, so every copy of this module and every child agrees. Returns the new state. */
export function setNoQuarter(on: boolean): boolean {
  if (on) process.env[ENV] = "1";
  else delete process.env[ENV];
  return on;
}

/** Flip the state. Returns the new state. */
export function toggleNoQuarter(): boolean {
  return setNoQuarter(!noQuarterActive());
}
