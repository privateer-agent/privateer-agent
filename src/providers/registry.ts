import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOllama } from "ollama-ai-provider-v2";
import type { ProviderConfig, ProviderName } from "../config/schema.ts";

// Each factory turns provider credentials + a model id into an AI SDK LanguageModel.
// This is the single seam that makes Privateer provider-agnostic: the agent loop,
// tools, and UI never know or care which provider is behind the model.
type Factory = (cfg: ProviderConfig, modelId: string) => LanguageModel;

// Whether a provider requires an API key to be usable (Ollama is local, so it doesn't).
const REQUIRES_KEY: Record<ProviderName, boolean> = {
  openrouter: true,
  anthropic: true,
  openai: true,
  ollama: false,
};

const FACTORIES: Record<ProviderName, Factory> = {
  openrouter: (cfg, modelId) =>
    // When the user enforces ZDR, pin routing to zero-data-retention endpoints so
    // prompts can't be retained upstream; OpenRouter rejects models that have none.
    createOpenRouter({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(
      modelId,
      cfg.enforceZdr ? { provider: { zdr: true } } : {},
    ),
  anthropic: (cfg, modelId) =>
    createAnthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  openai: (cfg, modelId) =>
    createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  ollama: (cfg, modelId) =>
    createOllama({ baseURL: cfg.baseURL })(modelId),
};

export function providerRequiresKey(name: ProviderName): boolean {
  return REQUIRES_KEY[name];
}

export function buildModel(name: ProviderName, cfg: ProviderConfig, modelId: string): LanguageModel {
  return FACTORIES[name](cfg, modelId);
}
