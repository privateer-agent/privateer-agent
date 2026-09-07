/**
 * May this process drive the machine's screen, mouse and keyboard at all?
 *
 * THE DEFAULT IS OFF, and that is the one way this differs from every other switch in
 * config/. relayExposure.ts defaults to ALLOWED because an unset variable there means
 * "nobody has expressed a preference, and the surfaces that open a socket are already
 * explicit acts". The opposite is true here: GUI control is not an extension of what
 * the agent could already do, it is a way around the whole moat. The permission gate
 * confines file operations to the working directory, refuses protected paths and
 * pattern-matches dangerous shell — and a mouse can open Terminal and type any of it,
 * click Allow on another application's consent dialog, or drive a browser that is
 * already logged into the user's bank. Nothing in classify.ts can see any of that
 * happen. So it exists only where a human has said, in as many words, that it may.
 *
 * ARMING IS A SEPARATE ACT FROM APPROVING. The gate still asks before every action
 * (permissions/mode.ts — kind "computer" never auto-allows, not even under `bypass`).
 * This switch decides something prior: whether the tools are REGISTERED at all. An
 * unarmed session does not have a `computer_control` that gets denied, it has no such
 * tool — the same distinction buildMoat already draws for web ("web off should mean the
 * tool doesn't exist for that run, not that it exists and is denied"). A model with a
 * tool it is refused on every call spends its context rediscovering that; a model
 * without the tool says it cannot do that and moves on.
 *
 * WHAT THIS DOES NOT DEFEND AGAINST, stated plainly because the alternative is implying
 * a guarantee we don't have: `--no-quarter` (PRIVATEER_NO_QUARTER) and the app's
 * unattended toggle are still a total bypass of the gate, computer actions included.
 * That is deliberate — a second, subtly-different total-bypass lever is worse than one
 * everybody understands — but it means ARMING plus NO-QUARTER is a session that will
 * move the mouse without asking. Both are explicit human acts, and the app's copy has
 * to say so where the two can be turned on together.
 *
 * Read at CALL time rather than latched at boot, for the reason relayExposure.ts gives:
 * a long-lived process whose parent re-stamps its environment (the desktop shell
 * re-spawning a child with a different answer) must honour the new answer on its next
 * tick rather than the one it happened to start with.
 */

const ON = new Set(["1", "true", "on", "yes"]);

/** The environment variable the desktop shell and the CLI flag both write. */
export const COMPUTER_CONTROL_ENV = "PRIVATEER_COMPUTER_CONTROL";

/**
 * Whether GUI control tools may be registered for this process.
 *
 * Unset, empty, or anything not in ON ⇒ false. Deliberately an allow-list rather than
 * a deny-list: a typo ("PRIVATEER_COMPUTER_CONTROL=ture") must fail CLOSED. The
 * inverse spelling would arm the machine on a misspelling, which is the wrong direction
 * for the one capability that can click through another app's consent dialog.
 */
export function computerControlArmed(): boolean {
  const v = process.env[COMPUTER_CONTROL_ENV]?.trim().toLowerCase();
  return v ? ON.has(v) : false;
}

/**
 * What to tell a user who asked for something the tools would have done. Written for
 * the model to relay verbatim, so it names the switch rather than the variable: someone
 * reading it is in an app or a terminal, not editing an environment.
 */
export function computerControlDisarmedHint(): string {
  return (
    "Screen control is off for this machine. It is off by default because it lets an agent " +
    "click and type anywhere, outside every other limit in place. Turn it on in Privateer → " +
    "Settings → Screen control, or start the CLI with --allow-computer-control."
  );
}
