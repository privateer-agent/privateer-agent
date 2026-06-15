import { KNOWN_PROVIDERS, type ProviderName } from "../config/schema.ts";
import { providerRequiresKey } from "./registry.ts";

// Human-facing metadata for each provider, used by the onboarding flow: a display
// label, where to get an API key, and the model to default to when the provider is
// chosen first. Keeps the registry (wiring) separate from presentation.
export interface ProviderMeta {
  name: ProviderName;
  label: string;
  requiresKey: boolean;
  defaultModel: string; // "provider:model" picked when this provider is selected first
  keyHint: string; // where to obtain a key, or a note for keyless providers
  baseURLDefault?: string; // shown as the placeholder for keyless/local providers
}

export const PROVIDER_META: Record<ProviderName, ProviderMeta> = {
  anthropic: {
    name: "anthropic",
    label: "Anthropic",
    requiresKey: providerRequiresKey("anthropic"),
    defaultModel: "anthropic:claude-opus-4-8",
    keyHint: "console.anthropic.com/settings/keys",
  },
  openai: {
    name: "openai",
    label: "OpenAI",
    requiresKey: providerRequiresKey("openai"),
    defaultModel: "openai:gpt-4o",
    keyHint: "platform.openai.com/api-keys",
  },
  openrouter: {
    name: "openrouter",
    label: "OpenRouter",
    requiresKey: providerRequiresKey("openrouter"),
    defaultModel: "openrouter:anthropic/claude-opus-4.8",
    keyHint: "openrouter.ai/keys",
  },
  ollama: {
    name: "ollama",
    label: "Ollama (local)",
    requiresKey: providerRequiresKey("ollama"),
    defaultModel: "ollama:llama3.1",
    keyHint: "runs locally — no key needed",
    baseURLDefault: "http://localhost:11434/api",
  },
  nearai: {
    name: "nearai",
    label: "NEAR AI (private TEE inference)",
    requiresKey: providerRequiresKey("nearai"),
    defaultModel: "nearai:zai-org/GLM-5.1-FP8",
    keyHint: "cloud.near.ai → API Keys",
  },
};

// Provider metadata in display order.
export const PROVIDER_LIST: ProviderMeta[] = KNOWN_PROVIDERS.map((n) => PROVIDER_META[n]);
