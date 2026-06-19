import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOllama } from "ollama-ai-provider-v2";
import type { ProviderConfig, ProviderName } from "../config/schema.ts";
import { authedFetch, serverBaseUrl } from "../auth/privateer.ts";

// NEAR AI Cloud's OpenAI-compatible gateway. Every model behind it runs inside a
// Trusted Execution Environment (TEE), so requests are confidential and each one
// can be cryptographically attested (see ./attestation.ts). It only implements the
// Chat Completions API, so the factory below pins `.chat()` rather than the SDK's
// default Responses transport, and supplies this base when the user hasn't set one.
export const NEARAI_BASE_URL = "https://cloud-api.near.ai/v1";

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
  nearai: true,
  // Privateer authenticates via a stored account session, not a typed key, so
  // there's no key to prompt for. Readiness is "are you logged in?" — see
  // providers/resolve.ts, which special-cases this against hasCredentials().
  privateer: false,
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
  nearai: (cfg, modelId) =>
    // OpenAI-compatible, but Chat-Completions-only — `.chat()` avoids the SDK's
    // default Responses transport, which NEAR's TEE endpoints don't implement.
    createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? NEARAI_BASE_URL }).chat(modelId),
  privateer: (cfg, modelId) =>
    // Routes to the Privateer server's billed, OpenAI-compatible agent endpoint.
    // `authedFetch` injects the account JWT and refreshes it on 401, so no key is
    // configured here (apiKey is a placeholder the SDK requires). Chat-Completions
    // only, hence `.chat()`. The modelId is a normal OpenRouter id, resolved and
    // billed server-side. Base URL: cfg override → account server → default.
    createOpenAI({
      apiKey: "privateer-session",
      baseURL: `${(cfg.baseURL ?? serverBaseUrl()).replace(/\/$/, "")}/api/agent/v1`,
      fetch: authedFetch as typeof fetch,
    }).chat(modelId),
};

export function providerRequiresKey(name: ProviderName): boolean {
  return REQUIRES_KEY[name];
}

export function buildModel(name: ProviderName, cfg: ProviderConfig, modelId: string): LanguageModel {
  return FACTORIES[name](cfg, modelId);
}
