// Privacy toggle: completely disable pi-privacy across agent sessions.
//
// When active, all pi-privacy hooks are completely bypassed:
//   - Outbound PII scanning and prompts are disabled (IP addresses, emails, and
//     other non-sensitive data that trigger detection can be sent as-is with NO interference).
//   - Unattended mode does NOT auto-redact PII.
//   - Tool exfiltration guards and warnings are disabled.
//   - Tool result credential scanning / redaction is disabled.
//   - Model downgrade guards are disabled.
//
// THE ENV VAR IS THE STORE:
// Exactly like `src/permissions/noQuarter.ts`, state is stored in `process.env.PRIVATEER_PRIVACY_OFF`
// and `process.env.PI_PRIVACY_OFF`:
//   1. ACROSS PROCESSES: subagent children inherit the env var and run without privacy gates.
//   2. ACROSS EXTENSIONS: different jiti instances and late-loaded extensions all share process.env.
//   3. LAUNCH CONFIG: users can launch with `PRIVATEER_PRIVACY_OFF=1` or `PI_PRIVACY_OFF=1`
//      or `--privacy-off` / `--no-privacy` CLI flags.

const ENV = "PRIVATEER_PRIVACY_OFF";
const ALT_ENV = "PI_PRIVACY_OFF";

/** Set while the filter is off BECAUSE no quarter took it down (src/permissions/noQuarter.ts). */
export const NO_QUARTER_PRIVACY_MARK = "PRIVATEER_PRIVACY_OFF_BY_NO_QUARTER";

/** True while pi-privacy is completely disabled for this session. Read live, never cached. */
export function privacyDisabled(): boolean {
  return process.env[ENV] === "1" || process.env[ALT_ENV] === "1";
}

// WHO ELSE NEEDS TO KNOW. The env var is the store, but it is not observable — and the
// switch now has two drivers on the same session: `/privacy off` typed into a composer,
// and the app's own shield toggle (RemoteBridge's onPrivacy). Whichever one moves it, the
// app's switch has to follow, or the desktop shows a shield over a session whose filter
// its own composer just turned off. Listeners fire on a real CHANGE only, so a re-assert
// is not an event; failures are swallowed, because a subscriber that throws must not
// leave the flag half-applied.
const listeners = new Set<(disabled: boolean) => void>();

/** Watch the disabled state. Returns an unsubscribe. Fires only when the value changes. */
export function onPrivacyDisabledChange(fn: (disabled: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Set the disabled state. Modifies process.env so every module copy and child process agrees.
 * Returns the new state. Clears the no-quarter mark: an explicit set is the operator's call,
 * so raising the moat later won't flip it back (noQuarter.ts re-sets the mark after its own call).
 */
export function setPrivacyDisabled(disabled: boolean): boolean {
  const before = privacyDisabled();
  delete process.env[NO_QUARTER_PRIVACY_MARK];
  if (disabled) {
    process.env[ENV] = "1";
    process.env[ALT_ENV] = "1";
  } else {
    delete process.env[ENV];
    delete process.env[ALT_ENV];
  }
  if (before !== disabled) {
    for (const fn of listeners) {
      try { fn(disabled); } catch { /* a watcher must not break the toggle */ }
    }
  }
  return disabled;
}

/** Flip the disabled state. Returns the new state. */
export function togglePrivacyDisabled(): boolean {
  return setPrivacyDisabled(!privacyDisabled());
}
