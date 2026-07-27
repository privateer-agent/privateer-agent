// No-quarter: the moat fully lowered for a session — every action auto-approves
// with no prompt (dangerous shell, destructive tools, out-of-cwd, protected files).
// This is the single source of truth for that state; the gate reads it through
// ModeGate.getSkipAllPermissions, which sits above every other policy check.
//
// Two ways in, one state:
//   1. `privateer --no-quarter` at launch → PRIVATEER_NO_QUARTER=1 (see
//      bin/privateer-launch.mjs), which seeds `active` below.
//   2. shift+tab in a live session → toggleNoQuarter(). This is the "step away from
//      the keyboard" switch: flip it on and the agent runs to completion instead of
//      stopping on the next approval prompt.
//
// Toggling MIRRORS the env var, because that's how the state reaches subagents: a
// pi-subagents child is a `pi` subprocess that inherits this process's env and reads
// PRIVATEER_NO_QUARTER in its own gate. Children spawned after a toggle therefore
// match the parent; ones already running keep the posture they started with.
//
// IMPORT-SAFETY: no Pi imports, no node builtins — safe to load from anywhere,
// including boot-ordered entrypoints (see boot.ts's ORDERING CONTRACT).

const ENV = "PRIVATEER_NO_QUARTER";

// Seeded from the launch flag so `--no-quarter` and the toggle share one state.
let active = process.env[ENV] === "1";

/** True while the gate is fully lowered for this session. */
export function noQuarterActive(): boolean {
  return active;
}

/** Set the state (and mirror it to the env for future subagent children). Returns the new state. */
export function setNoQuarter(on: boolean): boolean {
  active = on;
  if (on) process.env[ENV] = "1";
  else delete process.env[ENV];
  return active;
}

/** Flip the state. Returns the new state. */
export function toggleNoQuarter(): boolean {
  return setNoQuarter(!active);
}
