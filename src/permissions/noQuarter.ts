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
// NO QUARTER ALSO TAKES THE PRIVACY FILTER DOWN. Lowering the moat is the "step away"
// switch, and a turn that runs to completion unattended must not stall on pi-privacy's
// PII prompt either — so going to no quarter is also `/privacy off`. Raising the moat
// puts the filter back, but ONLY if no quarter is what took it down: a session already
// running with `/privacy off` (or `--no-privacy`) stays off. The marker that records
// "no quarter did this" lives in the env for the same cross-copy reasons as the flag,
// and setPrivacyDisabled clears it — so an explicit `/privacy on|off` mid-no-quarter
// is the operator's word and a later shift+tab doesn't overrule it.
//
// IMPORT-SAFETY: no Pi imports, no node builtins — safe to load from anywhere,
// including boot-ordered entrypoints (see boot.ts's ORDERING CONTRACT).

import { NO_QUARTER_PRIVACY_MARK, privacyDisabled, setPrivacyDisabled } from "../config/privacyDisabled.ts";

const ENV = "PRIVATEER_NO_QUARTER";

/** True while the gate is fully lowered for this session. Read live, never cached. */
export function noQuarterActive(): boolean {
  return process.env[ENV] === "1";
}

/** Set the state — in the env, so every copy of this module and every child agrees. Returns the new state. */
export function setNoQuarter(on: boolean): boolean {
  if (on) {
    process.env[ENV] = "1";
    if (!privacyDisabled()) {
      setPrivacyDisabled(true);
      process.env[NO_QUARTER_PRIVACY_MARK] = "1";
    }
  } else {
    delete process.env[ENV];
    if (process.env[NO_QUARTER_PRIVACY_MARK] === "1") setPrivacyDisabled(false); // clears the mark
  }
  return on;
}

/** Flip the state. Returns the new state. */
export function toggleNoQuarter(): boolean {
  return setNoQuarter(!noQuarterActive());
}
