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

/** True while pi-privacy is completely disabled for this session. Read live, never cached. */
export function privacyDisabled(): boolean {
  return process.env[ENV] === "1" || process.env[ALT_ENV] === "1";
}

/**
 * Set the disabled state. Modifies process.env so every module copy and child process agrees.
 * Returns the new state.
 */
export function setPrivacyDisabled(disabled: boolean): boolean {
  if (disabled) {
    process.env[ENV] = "1";
    process.env[ALT_ENV] = "1";
  } else {
    delete process.env[ENV];
    delete process.env[ALT_ENV];
  }
  return disabled;
}

/** Flip the disabled state. Returns the new state. */
export function togglePrivacyDisabled(): boolean {
  return setPrivacyDisabled(!privacyDisabled());
}
