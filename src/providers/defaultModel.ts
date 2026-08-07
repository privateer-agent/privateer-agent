// The single source of truth for "which model do we default to?" — shared by every
// entry point that has to pick a model when the user hasn't named one: the REPL
// (cli/chat.ts), the harbor (routines), the channels runner, and the login-time hook
// that seeds Pi's TUI default (ensurePiDefaultModel).
//
// The bug this fixes: each of those sites used to hardcode `openrouter/openai/gpt-4o-
// mini`, which assumes a BYO OpenRouter key. A user who is ONLY signed into their
// Privateer subscription has no such key, so the runtime resolved to OpenRouter and
// then failed at request time with "No API key found for openrouter". Being signed in
// never nominated a model. resolveDefaultModel() makes the account channel the default
// the moment credentials exist, and keeps the legacy BYO behaviour otherwise.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasCredentials } from "../auth/privateer.ts";
import { agentDir } from "../config/paths.ts";

// A capable Tinfoil chat model, and Privateer's default everywhere. Tinfoil runs it
// inside an attestable TEE (the serving enclave's quote is published and the live TLS
// key is bound to it), which is the strongest privacy tier we offer — so a capable
// model on that tier is what a privacy-first agent should boot on.
// One definition, three consumers: this resolver, providers/account.ts's seed catalog,
// and bin/privateer-launch.mjs (which mirrors the id — keep them in step).
//
// This has moved twice. The history matters, because both moves were about the same
// two axes — first-token latency and reasoning control — pulling in opposite directions:
//
//   • until 2026-08-01 — glm-5-2.
//   • 2026-08-01 → 2026-08-06 — kimi-k2-6, a LATENCY swap, not a capability one. Over
//     22 requests spaced 20s apart on the account channel, glm-5-2 stalled before its
//     first token on 9 of them — 33s to 98s each, with the model demonstrably warm 20
//     seconds earlier, so it was contention in that deployment rather than a cold start
//     anything here can warm up. kimi-k2-6 and gpt-oss-120b, same enclave provider,
//     same tier, same transport, stalled 0 times in 20 (medians 1.2s and 1.0s). That
//     run reproduced the stalls on BOTH the sealed and the cleartext path, which is
//     what ruled out the shim, the relay and the proxy as the cause.
//   • 2026-08-06 — gpt-oss-120b, on REASONING CONTROL, having ruled out a return to
//     glm-5-2 by re-measuring. kimi-k2-6 reasons on every turn with no working off
//     switch: thinkingProfile (providers/account.ts) omits it deliberately because both
//     levers were probed and neither moved the reasoning volume. On an agent that makes
//     many small tool calls, a toggle that works is worth real latency — but not glm's
//     latency. Re-run of the probe above (14 rounds, 20s apart, TTFT to the first token
//     of any kind, all three models per round):
//
//         glm-5-2        median 4.6s  max 55.0s  stalls(>10s) 5/14
//         kimi-k2-6      median 0.9s  max  1.1s  stalls        0/14
//         gpt-oss-120b   median 0.4s  max  0.4s  stalls        0/14
//
//     glm-5-2's stalls (55.0 / 46.3 / 46.3 / 55.0 / 29.9s) interleave with 1.0s
//     responses on the same key in the same minute while the other two never waver —
//     the 2026-08-01 signature, unchanged. At ~36% per request a ten-tool-call task
//     stalls with ~99% probability, so it is not defaultable however good the model is.
//     gpt-oss-120b takes the latency crown outright AND honours reasoning_effort
//     (verified: low → 9 reasoning deltas, high → 61), so it is the only one of the
//     three that gives the user a working dial. It is a smaller model than GLM 5.2 and
//     Kimi K2.6; that capability trade was made knowingly. It also serves from NEAR as
//     well as Tinfoil — the only capable model here with two attested homes.
//
// Re-measure before moving this again. The stall behaviour is a property of a
// provider's deployment, not of a model, and it has already changed under us twice.
export const TINFOIL_MODEL_ID = "tinfoil/gpt-oss-120b";

// Same model, reached two ways:
//   - TINFOIL_DEFAULT_SPEC — direct to inference.tinfoil.sh with the user's own
//     TINFOIL_API_KEY, where pi-privacy can CLIENT-attest the enclave live.
//   - ACCOUNT_DEFAULT_SPEC — through the Privateer subscription (the `privateer`
//     provider proxies it), so a signed-in user needs no BYO key at all.
// The direct route wins when a key is present; otherwise being signed in is enough.
export const TINFOIL_DEFAULT_SPEC = TINFOIL_MODEL_ID;
export const ACCOUNT_DEFAULT_MODEL_ID = TINFOIL_MODEL_ID;
export const ACCOUNT_DEFAULT_SPEC = `privateer/${ACCOUNT_DEFAULT_MODEL_ID}`;

// The account channel's NEAR confidential-compute model — no longer the default, but
// still the one account model we can attest end-to-end through the server proxy, so
// it stays first in the seed catalog after the default. See providers/account.ts.
export const ACCOUNT_NEAR_MODEL_ID = "near/zai-org/GLM-5.1-FP8";

// The legacy BYO default, kept ONLY for a user who set an OpenRouter key and isn't
// signed in — it's what their key actually pays for. It is deliberately no longer the
// keyless fallback: landing a signed-out, keyless terminal on OpenRouter is what
// produced the "No API key found for openrouter" dead end that /login couldn't
// explain. With no key and no login we now point at the account channel instead, so
// the error names Privateer and /login is visibly the fix.
export const LEGACY_BYO_FALLBACK = "openrouter/openai/gpt-4o-mini";

// BYO providers we can positively detect from the environment, in preference order.
// Each model id matches Pi's own defaultModelPerProvider so it actually resolves once
// the key is present. OpenRouter stays on the legacy cheap default for continuity.
const BYO_BY_KEY: Array<{ env: string; spec: string }> = [
  { env: "ANTHROPIC_API_KEY", spec: "anthropic/claude-opus-4-8" },
  { env: "OPENAI_API_KEY", spec: "openai/gpt-5.5" },
  { env: "OPENROUTER_API_KEY", spec: LEGACY_BYO_FALLBACK },
];

export interface ResolveDefaultModelOptions {
  // An explicit, user-chosen spec (e.g. config.defaultModel, a channel's `model`).
  // Wins over everything when non-empty — it's a deliberate choice, not a fallback.
  explicit?: string | null;
  // Override for testing / non-process callers. Defaults to process.env.
  env?: NodeJS.ProcessEnv;
  // Override the signed-in check (testing). Defaults to hasCredentials().
  signedIn?: boolean;
  // The user's saved Pi default ("provider/id"). undefined (the default) reads it
  // from agentDir()/settings.json; null skips it entirely — resolveSignedInModel
  // uses null because the sign-in TARGET must stay the confidential model (the
  // decision to stay on a saved pick is made explicitly at its call sites, where
  // the account channel still gets armed either way).
  saved?: string | null;
}

// The user's own persisted model pick: Pi writes defaultProvider + defaultModel to
// agentDir()/settings.json on EVERY interactive switch (AgentSession.setModel →
// setDefaultModelAndProvider — both the built-in selector and pi-privacy's /models
// picker land there). That makes it the strongest non-env signal of deliberate
// intent we have, so resolveDefaultModel ranks it right after PRIVATEER_MODEL.
// Returns "provider/id", or null when either half is missing.
export function savedPiDefaultSpec(): string | null {
  try {
    const raw = readFileSync(join(agentDir(), "settings.json"), "utf8").trim();
    if (!raw) return null;
    const s = JSON.parse(raw) as Record<string, unknown>;
    const provider = typeof s.defaultProvider === "string" ? s.defaultProvider.trim() : "";
    const modelId = typeof s.defaultModel === "string" ? s.defaultModel.trim() : "";
    return provider && modelId ? `${provider}/${modelId}` : null;
  } catch {
    return null;
  }
}

// Resolve the model spec ("provider/id") to use when no model is named. Pure and
// synchronous (only reads env + the credentials file), so it's safe to call from any
// entry point at startup. Precedence (mirrors bin/privateer-launch.mjs's launch logic,
// so the launcher, the REPL, and the next-launch seed all agree):
//   1. explicit user choice (config/channel)      — deliberate, always wins
//   2. PRIVATEER_MODEL env                         — dev/global override
//   3. the SAVED Pi default (settings.json)        — the model the user last picked
//      interactively; Pi persists every switch, so honoring it here is what makes a
//      /models pick actually stick across launches on every entry point
//   4. Tinfoil key present → the Tinfoil default   — strongest (client-attested) privacy
//   5. signed into Privateer → the same model over the subscription
//   6. a BYO provider whose key is present         — anthropic, openai, openrouter
//   7. nothing at all → the account default anyway — so the failure names Privateer
//      and /login is the visible fix, instead of a keyless OpenRouter dead end
export function resolveDefaultModel(opts: ResolveDefaultModelOptions = {}): string {
  const env = opts.env ?? process.env;

  const explicit = opts.explicit?.trim();
  if (explicit) return explicit;

  const fromEnv = env.PRIVATEER_MODEL?.trim();
  if (fromEnv) return fromEnv;

  const saved = opts.saved === undefined ? savedPiDefaultSpec() : opts.saved;
  if (saved) return saved;

  // Privacy-first: a Tinfoil key means we can run verifiable TEE inference right now,
  // which we prefer even over the account's NEAR channel — same order the launcher uses.
  if (env.TINFOIL_API_KEY?.trim()) return TINFOIL_DEFAULT_SPEC;

  const signedIn = opts.signedIn ?? hasCredentials();
  if (signedIn) return ACCOUNT_DEFAULT_SPEC;

  for (const { env: keyName, spec } of BYO_BY_KEY) {
    if (env[keyName]?.trim()) return spec;
  }

  // No key, no login. Point at the account channel regardless: it's the model this
  // terminal will run the moment they /login, so signing in needs no model switch at
  // all, and until then the error reads "No API key found for privateer" — which our
  // guidance turns into "you're not signed in · run /login".
  return ACCOUNT_DEFAULT_SPEC;
}

// The confidential model to switch the LIVE session onto the moment a user signs in.
// A terminal launched with a BYO key (or an explicit --model) is pinned to whatever it
// resolved at launch; without an in-session switch a mid-session /login changes nothing
// visible and the user is left wondering what signing in bought them. This resolves the
// model sign-in should activate RIGHT AWAY: Tinfoil GLM 5.2, direct when a Tinfoil key
// is present and over the subscription otherwise — no BYO key needed.
// PRIVATEER_MODEL still wins — a deliberate override is never stomped.
// `saved: null` on purpose: this is the sign-in TARGET, and the target is always the
// confidential model. Whether to actually move a session that sits on a deliberate
// saved pick is decided at the call sites (which arm the account channel either way).
export function resolveSignedInModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDefaultModel({ env, signedIn: true, saved: null });
}

// Split a "provider/id" spec on its first slash (model ids themselves contain "/", so
// only the first delimiter separates provider from model). Returns null for a spec
// with no provider prefix.
function splitSpec(spec: string): { provider: string; modelId: string } | null {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return null;
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

// The TUI consumer. Pi's own model resolution (findInitialModel) checks its saved
// settings default BEFORE it falls through to a keyless built-in, but nothing ever
// pointed that default at the account channel — Pi's provider-default table has no
// `privateer` entry, so a signed-in-only user landed on OpenRouter and errored. On a
// successful login we seed Pi's global settings.json (agentDir/settings.json — the
// same file its SettingsManager reads) with the account default, so the NEXT launch
// resolves cleanly.
//
// Guarded: we only write when the user has NOT already chosen a default (no
// `defaultModel` key), so a deliberate /model choice is never stomped. Best-effort —
// any read/parse/write failure is swallowed; a missing seed just means the user picks
// a model once via /model. Returns the spec written, or null if we left it alone.
//
// The default seed is resolveSignedInModel(), not the static account spec: now that
// the launcher HONORS a saved default (omits --model when one exists), seeding
// `privateer/…` for a Tinfoil-keyed user would demote them from direct
// client-attested inference to the subscription proxy on every later launch.
export function ensurePiDefaultModel(spec: string = resolveSignedInModel()): string | null {
  const parts = splitSpec(spec);
  if (!parts) return null;
  const settingsPath = join(agentDir(), "settings.json");
  try {
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf8").trim();
      if (raw) settings = JSON.parse(raw) as Record<string, unknown>;
    }
    // Respect an existing choice — presence of the key means the user (or Pi) already
    // has a default; don't override it.
    if (typeof settings.defaultModel === "string" && settings.defaultModel.trim()) {
      return null;
    }
    settings.defaultProvider = parts.provider;
    settings.defaultModel = parts.modelId;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    return spec;
  } catch {
    return null;
  }
}
