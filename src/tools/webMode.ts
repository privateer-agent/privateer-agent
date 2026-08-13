// Which web route an INTERACTIVE session takes — the user's own search provider, or
// Privateer's account-backed search.
//
// WHY THERE IS A CHOICE AT ALL. Two implementations of `web_search`/`web_fetch` ship
// with this agent and they buy different things:
//
//   own       @juicesharp/rpiv-web-tools against a provider the user configured
//             themselves (a Brave/Tavily/… key, or a self-hosted SearXNG). The query
//             reaches that provider and nobody else — a self-hosted SearXNG is the most
//             private web access we can offer — but it only exists once the user has
//             gone and got a key.
//   privateer tools/web.ts against the account API (/api/rag/*, Brave server-side). No
//             key to obtain, no key on the machine, per-account daily caps and metering —
//             but the derived query is visible to Privateer's servers.
//
// Before this, the terminal only ever got the first one, so a signed-in user at a prompt
// had no web access until they went and configured a provider, while the same account's
// unattended runs (harbor, channels, ACP) searched fine. Signing in is now enough.
//
// PRECEDENCE: A CONFIGURED PROVIDER ALWAYS WINS. Account search fills a gap; it never
// overrides a decision the user already made. Someone who stood up a SearXNG chose the
// more private route on purpose, and quietly re-pointing their searches at our servers
// (and billing their account for them) would undo that choice without telling them.
// So: configured ⇒ own, otherwise ⇒ privateer, with `PRIVATEER_WEB_SEARCH` or a
// `"provider": "privateer"` in the rpiv config as the escape hatch for someone who
// holds a key but wants the account path anyway.
//
// ONE ROUTE PER PROCESS. Pi resolves duplicate tool names first-registration-wins, so a
// session that loaded both packs would silently get whichever came first. The decision
// is therefore made ONCE, at extension load (extensions/privateer-web.ts), and only the
// winning pack registers its tools — see the SCOPE note in tools/web.ts. The consequence
// to know: configuring a provider mid-session takes effect at the next launch. Signing IN
// mid-session does not need one, because the account tools are already registered and
// only check credentials when called.
//
// This module is the decision, kept separate from the extension so it can be tested
// without Pi or jiti in the picture. No Pi imports, no side effects on load.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type WebMode = "own" | "privateer";

/** The fields we read off one of rpiv-web-tools' provider descriptors. */
export interface ProviderMetaLike {
  name: string;
  /** API-key env var, if the provider takes a key (BRAVE_SEARCH_API_KEY, …). */
  envVar?: string;
  /** Base-URL env var. Only self-hosted providers (SearXNG, Ollama) declare one. */
  baseUrlEnvVar?: string;
}

/** The fields we read out of ~/.config/rpiv-web-tools/config.json. */
export interface WebToolsConfigLike {
  provider?: string;
  /** Legacy top-level Brave key, still honoured by rpiv-web-tools' own resolver. */
  apiKey?: string;
  apiKeys?: Record<string, string>;
  baseUrls?: Record<string, string>;
}

/** Config-file / env value that pins the account path even when a provider is configured. */
export const PRIVATEER_PROVIDER_NAME = "privateer";

/** Force one route or the other: PRIVATEER_WEB_SEARCH=privateer | own. */
export const WEB_MODE_ENV = "PRIVATEER_WEB_SEARCH";

// Mirrors rpiv-web-tools' own DEFAULT_PROVIDER_NAME. It matters because the config file
// may name no provider at all, in which case that package still resolves a Brave key —
// so an unset `provider` with BRAVE_SEARCH_API_KEY in the environment is a configured
// user, and we must not take their searches off it.
const DEFAULT_PROVIDER_NAME = "brave";

// The one provider whose key was historically stored at the top level, again mirroring
// rpiv-web-tools: `config.apiKey` is still a working Brave key there until the next save
// migrates it into `apiKeys.brave`.
const LEGACY_TOP_LEVEL_KEY_PROVIDER = "brave";

/** Where rpiv-web-tools keeps its config (@juicesharp/rpiv-config's `configPath`). */
export function webToolsConfigPath(): string {
  return join(homedir(), ".config", "rpiv-web-tools", "config.json");
}

/**
 * Read that config, tolerantly. Every failure — absent, unreadable, malformed, not an
 * object — degrades to `{}`, i.e. "nothing configured", which is the same fail-soft
 * policy rpiv-web-tools applies to its own file. A broken config must not decide the
 * route by throwing at extension load.
 */
export function readWebToolsConfig(path: string = webToolsConfigPath()): WebToolsConfigLike {
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as WebToolsConfigLike;
  } catch {
    return {};
  }
}

const trimmed = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : undefined;
};

/**
 * Does the user have a working credential for `provider`? Deliberately the same order
 * rpiv-web-tools' resolveProviderApiKey uses — env, then the per-provider map, then the
 * legacy top-level field for Brave — because agreeing with it is the whole point: we are
 * answering "would that package be able to search?", not inventing our own notion of
 * configured.
 */
function resolveKey(
  provider: string,
  meta: ProviderMetaLike | undefined,
  config: WebToolsConfigLike,
  env: Record<string, string | undefined>,
): string | undefined {
  const envKey = meta?.envVar ? trimmed(env[meta.envVar]) : undefined;
  if (envKey) return envKey;
  const configKey = trimmed(config.apiKeys?.[provider]);
  if (configKey) return configKey;
  if (provider === LEGACY_TOP_LEVEL_KEY_PROVIDER) return trimmed(config.apiKey);
  return undefined;
}

export interface WebModeDecision {
  mode: WebMode;
  /** The rpiv-web-tools provider the decision was made about ("brave" when unset). */
  provider: string;
  /** Why, in a few words — for tests and for the `/web-tools` diagnostic line. */
  reason: string;
}

/**
 * Decide the route for this process.
 *
 * `providers` is rpiv-web-tools' PROVIDERS metadata, passed in rather than imported so
 * this stays testable and so a missing package (the pack is optional — the launcher drops
 * a shim whose target isn't installed) degrades to "no provider is configured", which is
 * the truth: without the package there is nothing to configure.
 */
export function resolveWebMode(opts: {
  providers: readonly ProviderMetaLike[];
  config: WebToolsConfigLike;
  env?: Record<string, string | undefined>;
}): WebModeDecision {
  const { providers, config } = opts;
  const env = opts.env ?? process.env;

  const configured = trimmed(config.provider);
  const provider = configured ?? DEFAULT_PROVIDER_NAME;

  // 1. The explicit override, either way. Note "own" is honoured even with nothing
  //    configured: the user gets rpiv-web-tools' own "run /web-tools" prompt, which is
  //    the right answer for someone who has just told us they want their own provider.
  const forced = trimmed(env[WEB_MODE_ENV])?.toLowerCase();
  if (forced === PRIVATEER_PROVIDER_NAME) return { mode: "privateer", provider, reason: `${WEB_MODE_ENV} set` };
  if (forced === "own") return { mode: "own", provider, reason: `${WEB_MODE_ENV} set` };

  // 2. `"provider": "privateer"` in the config file — the persistent form of the same
  //    choice, for someone who holds a key but wants the account path anyway. It is not a
  //    provider rpiv-web-tools knows (its factory would throw on it), which is exactly why
  //    it is safe to borrow as our marker: it can only have been set to mean this.
  if (configured?.toLowerCase() === PRIVATEER_PROVIDER_NAME) {
    return { mode: "privateer", provider, reason: "account search pinned in config" };
  }

  const meta = providers.find((p) => p.name === provider);

  // 3. A key for the active provider — from the environment or the config file.
  if (resolveKey(provider, meta, config, env)) {
    return { mode: "own", provider, reason: `${provider} key configured` };
  }

  // 4. Self-hosted providers (SearXNG, Ollama) need no key — SELECTING one is the whole
  //    configuration, since rpiv-web-tools falls back to the provider's default URL. So a
  //    bare `"provider": "searxng"` is a working setup and must not be overridden.
  //
  //    Only a SELECTED provider counts, here and above. A URL env var alone is not read as
  //    intent, however tempting: Ollama's is OLLAMA_HOST, which is set on any machine
  //    running a local model for reasons that have nothing to do with search. Honouring it
  //    would hand that user rpiv-web-tools with its unconfigured default provider — a
  //    terminal whose every search fails — instead of the account search they can actually
  //    use. Matching what rpiv-web-tools itself would resolve is the rule; guessing at
  //    half-configured states is not.
  if (configured && meta?.baseUrlEnvVar) {
    return { mode: "own", provider, reason: `${provider} selected (self-hosted)` };
  }

  // 5. A provider we don't recognise was named — a newer rpiv-web-tools than the metadata
  //    we were handed, or a typo. Either way the user made a choice about their own
  //    provider; let that package own the outcome, including telling them it's unknown.
  if (configured && !meta) return { mode: "own", provider, reason: `unrecognised provider "${provider}"` };

  return { mode: "privateer", provider, reason: "no provider configured" };
}
