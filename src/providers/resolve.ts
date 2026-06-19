import type { LanguageModel } from "ai";
import type { Config } from "../config/schema.ts";
import { KNOWN_PROVIDERS, type ProviderName } from "../config/schema.ts";
import { buildModel, providerRequiresKey } from "./registry.ts";
import { hasCredentials } from "../auth/privateer.ts";

// Privateer's readiness is session-based, not key-based: ready iff logged in.
function providerReady(name: ProviderName, cfg: { apiKey?: string }): boolean {
  if (name === "privateer") return hasCredentials();
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
  if (provider !== "privateer" && providerRequiresKey(provider) && !cfg.apiKey) {
    throw new Error(
      `No API key for "${provider}". Set ${provider.toUpperCase()}_API_KEY or add it to ~/.privateer/config.json.`,
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
