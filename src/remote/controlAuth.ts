// Shared fail-closed gate for signed app->terminal control frames (H2).
//
// Every mutating control frame the app sends over the (untrusted) relay --
// routines_save/delete/set_enabled/run, extensions_add/remove,
// skills_create/delete/set_enabled, channels_remove -- is signed by the account and
// MUST be verified before it takes effect, or a malicious server could forge it (a
// forged routine yields a headless-bypass session = RCE; a forged extensions_add
// installs an npm package = RCE; a forged skills_create injects an auto-invoked
// skill). channels_save has its own bespoke verify (it also carries sealed secrets);
// everything else routes through here.
//
// Both loci call this: the daemon (routines_*/channels_remove, termId = routineRelayId)
// and each interactive terminal (extensions_*/skills_*, termId = the relay's id).
//
// Fail-closed: no pinned account key, a missing signature, a bad signature, or a stale
// ts all reject the mutation. On success the per-terminal replay watermark advances.
import { loadAccountSignKey, loadLastControlTs, saveLastControlTs } from "../crypto/accountTrust.ts";
import { verifyControl } from "../crypto/accountVerify.ts";

export interface ControlAuthResult {
  ok: boolean;
  message?: string;
}

/**
 * Authorize a mutating control frame against the pinned account key + replay watermark.
 * `termId` is THIS terminal's id (verification binds it, so a signature for another
 * terminal won't match). Returns { ok:true } to proceed, or { ok:false, message } to
 * refuse — the caller surfaces the message and does NOT perform the mutation.
 *
 * `opts.strict` (default false) governs the watermark comparison:
 *   - non-strict: reject ts BELOW the watermark; ACCEPT at-or-above. Correct for
 *     idempotent config mutations (routines/skills/extensions/channels save|delete),
 *     where replaying the latest signed frame just re-applies the same state — harmless.
 *   - strict: reject ts AT-or-below the watermark. Required for NON-idempotent, effectful
 *     actions (task_submit/task_spawn — each RUNS a headless session), where a malicious
 *     relay replaying the latest signed frame (same ts) would re-run the task / spawn
 *     another session (inference-cost + resource abuse). Strict forces every accepted
 *     effectful frame to carry a strictly-fresh ts, which the server cannot fabricate (it
 *     can't sign) — so it can only replay old frames, all of which are now refused.
 */
export function authorizeControl(
  termId: string,
  action: string,
  args: Record<string, unknown>,
  sig?: string,
  ts?: number,
  opts?: { strict?: boolean },
): ControlAuthResult {
  const accountPub = loadAccountSignKey();
  if (!accountPub) {
    return { ok: false, message: "This terminal can't accept changes from the app yet — re-link it to establish trust." };
  }
  if (!sig || typeof ts !== "number") {
    return { ok: false, message: "Refused an unsigned change from the app." };
  }
  if (!verifyControl(accountPub, { termId, ts, action, args }, sig)) {
    return { ok: false, message: "Couldn't verify this change came from your account." };
  }
  const last = loadLastControlTs(termId);
  const tooOld = opts?.strict ? ts <= last : ts < last;
  if (tooOld) {
    return { ok: false, message: "Ignored an out-of-date change from the app." };
  }
  saveLastControlTs(termId, ts);
  return { ok: true };
}
