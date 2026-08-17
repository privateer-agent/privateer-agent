// The pi-privacy options that must be the SAME however a session reaches pi-privacy.
//
// There are two call sites, and they are genuinely separate routes — not one path with a
// fallback:
//
//   - src/config/moat.ts builds the extension from FACTORIES: the harbor's sessions,
//     live tasks, the channels runner, ACP, the lean REPL.
//   - extensions/privateer-privacy.ts is what Pi DISCOVERS for the interactive TUI, and
//     what bin/privateer-subagent.mjs injects (`-e`) into every subagent child.
//
// They drifted, and the drift was the bug this module exists to make impossible: the
// factory side wired the unattended signal and the discovered side didn't, so in the
// terminal `--no-quarter` (and shift+tab) lowered the permission moat while pi-privacy
// still stopped the turn with "PII detected — send as-is or redact?". No quarter means no
// prompts, from every gate in the session, not just ours.
//
// EVERYTHING pi-privacy is configured with lives here — there is no "and each side adds
// its own bit" left, because that arrangement is what produced both bugs. The other one:
// c2ee0fa added `resolveTier` to the discovered extension to stop the PII gate
// over-warning on the account channel (pi-privacy's own catalog only knows Privateer's
// PUBLIC developer key, which floors to zdr-policy, so a session on an ATTESTED account
// TEE model was judged unverified and asked about PII on every turn). The factory-built
// sessions never got it, and they never got the badge right either. Symmetrically, they
// had `privateerVerifiedTee` and the discovered copy didn't.
//
// IMPORT-SAFETY: this module reaches the account channel, so it pulls Pi-touching code
// and node builtins — it is NOT safe to import from a boot-ordered entrypoint (see
// boot.ts's ORDERING CONTRACT). moat.ts therefore imports it DYNAMICALLY, inside
// buildMoat(), exactly as it does every other Pi-touching import. Extensions load late
// and import it statically.

import { noQuarterActive } from "../permissions/noQuarter.ts";
import { cliPalette, detectScheme } from "../ui/palette.ts";
import { accountPosture, privateerChannel } from "../providers/account.ts";
import { hasCredentials } from "../auth/privateer.ts";

// Color-coat pi-privacy's auto-redact notice as the moat acting on your behalf: the red
// no-quarter flag (same glyph and color as the no-quarter banner in chat.ts and the gate
// extension's status line), body in the accent color — distinct from a yellow warning and
// from a red error, because this is neither: it's the answer we gave for you.
function renderPiiAutoRedact(notice: string): string {
  const p = cliPalette(detectScheme());
  const body = notice.startsWith("⚑ ") ? notice.slice(2) : notice;
  return `${p.RED}⚑${p.RESET} ${p.CYAN}${body}${p.RESET}`;
}

/** The pi-privacy options every Privateer session gets, whichever route built it. */
export function sharedPrivacyOptions() {
  return {
    // The account channel's real posture. pi-privacy ships a `privateer` provider, but it
    // is the PUBLIC developer-key channel (sk-priv-…, server-proxied and unverifiable
    // end-to-end), so from the package alone every privateer/* model floors to
    // zdr-policy. The in-app ACCOUNT channel is a different thing — its own OAuth
    // session, account server and sealed relay — and only the host can say what it
    // resolves to: tee-verified for a quote WE checked over the sealed path,
    // tee-unverified for a proxied enclave we can't bind to this connection, zdr-policy
    // for the ZDR-channel models. Without this hook a session running an ATTESTED TEE
    // model is judged unverified, so the badge lies and the PII gate asks about every
    // turn — the over-warning c2ee0fa fixed for the terminal and nowhere else.
    resolveTier: async (provider: string, modelId: string) => {
      if (provider !== "privateer") return undefined; // pi-privacy handles its own providers
      return (await accountPosture(modelId)).tier;
    },
    // Per-model verified-TEE capability for pi-privacy's /models picker: show Privateer's
    // TEE-channel models (near/tinfoil/phala) as "◆ Verifiable TEE" when logged in, while
    // ZDR-channel models stay at their honest floor. The live verdict still comes from
    // resolveTier above on select — this only lifts the label.
    privateerVerifiedTee: (m: any) => hasCredentials() && privateerChannel(m.id ?? "") === "tee",
    // No quarter = unattended. The PII send-or-redact question would stall a session the
    // operator explicitly stepped away from, so pi-privacy swallows it the SAFE way —
    // redact, then send — and reports what it masked as output instead of asking. A live
    // function, not a boolean: shift+tab / `/no-quarter` flips this mid-session and the
    // gate re-reads it on every request.
    piiUnattended: noQuarterActive,
    renderPiiAutoRedact,
    // pi-privacy's INGEST gate: credentials arriving in a tool result are masked before
    // they enter context (otherwise they're re-sent every turn and written to the session
    // file on disk). We already redact tool output in src/ext/permissionGate.ts, so its
    // default "warn" would put an interactive prompt in front of something this app has
    // always handled silently — "redact" keeps our UX and still takes the added coverage.
    //
    // The two redactors are COMPLEMENTARY, not duplicative, which is why we run both:
    // ours masks the configured provider keys by exact value (from env/config) plus the
    // provider-specific shapes (sk-/AIza/xai-/gsk_/csk-/vapi_/fw_/Z.ai, auth headers);
    // pi-privacy's catches what shows up in USER code and shell output — AWS AKIA/ASIA,
    // GitHub gh[pousr]_, JWTs, PEM private-key blocks, Slack, Stripe — none of which our
    // patterns match.
    //
    // Order between the two is NOT guaranteed: pi discovers extensions with a bare
    // readdirSync and never sorts, so it's filesystem-dependent (alphabetical on this box
    // today, not by contract). "redact" makes that moot — both handlers run
    // unconditionally and each masks its own patterns, so the surviving content is the
    // same either way. Under "warn" the order WOULD matter, since it decides whether the
    // prompt is raised on a raw key or one we already masked.
    toolResultPolicy: "redact" as const,
  };
}
