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
 */
export function authorizeControl(
  termId: string,
  action: string,
  args: Record<string, unknown>,
  sig?: string,
  ts?: number,
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
  if (ts < last) {
    return { ok: false, message: "Ignored an out-of-date change from the app." };
  }
  saveLastControlTs(termId, ts);
  return { ok: true };
}
