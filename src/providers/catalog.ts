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
  google: {
    name: "google",
    label: "Google (Gemini)",
    requiresKey: providerRequiresKey("google"),
    defaultModel: "google:gemini-3.5-flash",
    keyHint: "aistudio.google.com/apikey",
  },
  xai: {
    name: "xai",
    label: "xAI (Grok)",
    requiresKey: providerRequiresKey("xai"),
    defaultModel: "xai:grok-4.3",
    keyHint: "console.x.ai → API Keys",
  },
  groq: {
    name: "groq",
    label: "Groq (fast inference)",
    requiresKey: providerRequiresKey("groq"),
    defaultModel: "groq:llama-3.3-70b-versatile",
    keyHint: "console.groq.com/keys",
  },
  mistral: {
    name: "mistral",
    label: "Mistral (EU)",
    requiresKey: providerRequiresKey("mistral"),
    defaultModel: "mistral:mistral-large-latest",
    keyHint: "console.mistral.ai → API Keys",
  },
  zai: {
    name: "zai",
    label: "Z.ai (GLM)",
    requiresKey: providerRequiresKey("zai"),
    defaultModel: "zai:glm-5",
    keyHint: "z.ai → API Keys (coding-plan subscribers: set the coding base URL in /keys)",
  },
  moonshot: {
    name: "moonshot",
    label: "Moonshot (Kimi)",
    requiresKey: providerRequiresKey("moonshot"),
    defaultModel: "moonshot:kimi-k2.7-code",
    keyHint: "platform.moonshot.ai → API Keys",
  },
  cerebras: {
    name: "cerebras",
    label: "Cerebras (fast inference)",
    requiresKey: providerRequiresKey("cerebras"),
    defaultModel: "cerebras:gpt-oss-120b",
    keyHint: "cloud.cerebras.ai → API Keys",
  },
  tinfoil: {
    name: "tinfoil",
    label: "Tinfoil (private TEE inference)",
    requiresKey: providerRequiresKey("tinfoil"),
    defaultModel: "tinfoil:deepseek-v4-pro",
    keyHint: "tinfoil.sh → dashboard → API Keys",
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
  custom: {
    name: "custom",
    label: "Custom (OpenAI-compatible)",
    requiresKey: providerRequiresKey("custom"),
    // No universal model id exists for an arbitrary endpoint; "default" is a
    // last-resort fallback (several local servers accept or ignore the model id).
    // In practice the live listing supplies real ids the moment a URL is entered.
    defaultModel: "custom:default",
    keyHint: "any OpenAI-compatible endpoint — LM Studio, vLLM, llama.cpp, a proxy…",
    baseURLDefault: "http://localhost:1234/v1",
  },
  privateer: {
    name: "privateer",
    // Default to a NEAR confidential-compute (TEE) model: it's the strongest
    // privacy guarantee, runs through the same billed agent endpoint, and was
    // verified to pass agent tool_calls. Switch to any listed model with /model.
    label: "Privateer account (billed to your subscription)",
    requiresKey: providerRequiresKey("privateer"),
    defaultModel: "privateer:near/deepseek-ai/DeepSeek-V4-Flash",
    keyHint: "sign in with /login — no API key needed",
  },
};

// Provider metadata in display order.
export const PROVIDER_LIST: ProviderMeta[] = KNOWN_PROVIDERS.map((n) => PROVIDER_META[n]);
