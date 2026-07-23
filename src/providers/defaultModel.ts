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

// Tinfoil's most capable chat model, and Privateer's default everywhere. Tinfoil runs
// GLM 5.2 inside an attestable TEE (the serving enclave's quote is published and the
// live TLS key is bound to it), which is the strongest privacy tier we offer — so the
// most capable model on that tier is what a privacy-first agent should boot on.
// One definition, three consumers: this resolver, providers/account.ts's seed catalog,
// and bin/privateer-launch.mjs (which mirrors the id — keep them in step).
export const TINFOIL_MODEL_ID = "tinfoil/glm-5-2";

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
}

// Resolve the model spec ("provider/id") to use when no model is named. Pure and
// synchronous (only reads env + the credentials file), so it's safe to call from any
// entry point at startup. Precedence (mirrors bin/privateer-launch.mjs's launch logic,
// so the launcher, the REPL, and the next-launch seed all agree):
//   1. explicit user choice (config/channel)      — deliberate, always wins
//   2. PRIVATEER_MODEL env                         — dev/global override
//   3. Tinfoil key present → Tinfoil GLM 5.2       — strongest (client-attested) privacy
//   4. signed into Privateer → the same model over the subscription
//   5. a BYO provider whose key is present         — anthropic, openai, openrouter
//   6. nothing at all → the account default anyway — so the failure names Privateer
//      and /login is the visible fix, instead of a keyless OpenRouter dead end
export function resolveDefaultModel(opts: ResolveDefaultModelOptions = {}): string {
  const env = opts.env ?? process.env;

  const explicit = opts.explicit?.trim();
  if (explicit) return explicit;

  const fromEnv = env.PRIVATEER_MODEL?.trim();
  if (fromEnv) return fromEnv;

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
export function resolveSignedInModel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDefaultModel({ env, signedIn: true });
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
export function ensurePiDefaultModel(spec: string = ACCOUNT_DEFAULT_SPEC): string | null {
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
