import type { LanguageModel } from "ai";
import type { Config } from "../config/schema.ts";
import { KNOWN_PROVIDERS, type ProviderName } from "../config/schema.ts";
import { buildModel, providerRequiresKey } from "./registry.ts";
import { hasCredentials } from "../auth/privateer.ts";

// Whether a provider's credentials make it usable. Privateer's readiness is
// session-based (ready iff logged in); the custom endpoint's is URL-based (the
// key is optional — many local servers don't need one); everything else is
// key-based or keyless.
export function providerReady(name: ProviderName, cfg: { apiKey?: string; baseURL?: string }): boolean {
  if (name === "privateer") return hasCredentials();
  if (name === "custom") return Boolean(cfg.baseURL);
  return providerRequiresKey(name) ? Boolean(cfg.apiKey) : true;
}

export interface ResolvedModel {
  spec: string; // original "provider:model" string
  provider: ProviderName;
  modelId: string;
  model: LanguageModel;
}

function isKnownProvider(name: string): name is ProviderName {
  return (KNOWN_PROVIDERS as readonly string[]).includes(name);
}

// Parse a "provider:model" spec. The model id itself may contain ":" or "/"
// (e.g. "openrouter:anthropic/claude-opus-4.8"), so only the first ":" splits.
export function parseModelSpec(spec: string): { provider: string; modelId: string } {
  const idx = spec.indexOf(":");
  if (idx === -1) {
    throw new Error(
      `Invalid model "${spec}". Use "provider:model", e.g. openrouter:anthropic/claude-opus-4.8`,
    );
  }
  return { provider: spec.slice(0, idx).trim(), modelId: spec.slice(idx + 1).trim() };
}

// A Privateer account model is served over one of two privacy channels: NEAR's
// confidential-compute TEE (model ids prefixed "near/", cryptographically
// attestable) or the account's zero-data-retention OpenRouter proxy (every other
// id, pinned to ZDR endpoints server-side). The picker and the status-bar shield
// both surface this so the active privacy channel is always visible.
export type PrivateerChannel = "tee" | "zdr";

export function privateerChannel(modelId: string): PrivateerChannel {
  return modelId.startsWith("near/") ? "tee" : "zdr";
}

// Turn a model spec + config into a ready-to-use AI SDK model, validating that the
// provider is known and configured. Construction does not hit the network.
export function resolveModel(spec: string, config: Config): ResolvedModel {
  const { provider, modelId } = parseModelSpec(spec);

  if (!isKnownProvider(provider)) {
    throw new Error(
      `Unknown provider "${provider}". Known: ${KNOWN_PROVIDERS.join(", ")}.`,
    );
  }
  if (!modelId) throw new Error(`Missing model id in "${spec}".`);

  const cfg = config.providers[provider] ?? {};
  if (provider === "privateer" && !hasCredentials()) {
    throw new Error(`Not signed in to your Privateer account. Run /login first.`);
  }
  if (provider === "custom" && !cfg.baseURL) {
    throw new Error(
      `No endpoint URL for "custom". Run /keys and enter your OpenAI-compatible base URL.`,
    );
  }
  if (provider !== "privateer" && providerRequiresKey(provider) && !cfg.apiKey) {
    throw new Error(
      `No API key for "${provider}". Add one with /keys, or set ${provider.toUpperCase()}_API_KEY.`,
    );
  }

  return { spec, provider, modelId, model: buildModel(provider, cfg, modelId) };
}

// Which providers currently have working credentials — used by /doctor and provider listing.
export function configuredProviders(config: Config): { name: ProviderName; ready: boolean }[] {
  return KNOWN_PROVIDERS.map((name) => {
    const cfg = config.providers[name] ?? {};
    return { name, ready: providerReady(name, cfg) };
  });
}
