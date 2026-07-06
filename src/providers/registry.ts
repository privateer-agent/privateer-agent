import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createXai } from "@ai-sdk/xai";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createCerebras } from "@ai-sdk/cerebras";
import { createDeepSeek } from "@ai-sdk/deepseek";
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

// Tinfoil's OpenAI-compatible inference gateway. Like NEAR AI, every model runs
// inside a hardware enclave (TEE) — prompts are confidential to the host. Its
// attestation protocol differs from NEAR's, so /verify doesn't cover it (yet).
export const TINFOIL_BASE_URL = "https://inference.tinfoil.sh/v1";

// Z.ai's (GLM) OpenAI-compatible pay-as-you-go endpoint. Coding-plan subscribers
// get a separate quota-billed endpoint — point baseURL at
// https://api.z.ai/api/coding/paas/v4 to spend the subscription instead.
export const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";

// MiniMax's international OpenAI-compatible endpoint (Singapore entity; mainland
// China is a separate platform at api.minimaxi.com). M-series thinking arrives as
// inline <think> tags in content by default — no SDK-5-compatible dedicated
// package exists to split it out.
export const MINIMAX_BASE_URL = "https://api.minimax.io/v1";

// Qwen via Alibaba Cloud Model Studio's international ("classic" DashScope)
// OpenAI-compatible endpoint, hosted in the Singapore region. Newer docs are
// migrating to workspace-scoped URLs — users on those can override baseURL.
export const QWEN_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

// Venice.ai's OpenAI-compatible endpoint. Zero prompt retention by policy (not
// hardware-attested like the TEE providers above); its listing also carries
// "anonymized" models that proxy to upstream providers — flagged in listModels.
export const VENICE_BASE_URL = "https://api.venice.ai/api/v1";

// Venice appends its own system prompt to every chat request unless opted out —
// wrong for an agent that supplies its own. This fetch wrapper injects the
// opt-out into the JSON request body; non-JSON bodies pass through untouched.
export const veniceFetch: typeof fetch = (input, init) => {
  if (typeof init?.body === "string") {
    try {
      const body = JSON.parse(init.body);
      body.venice_parameters = { include_venice_system_prompt: false, ...body.venice_parameters };
      init = { ...init, body: JSON.stringify(body) };
    } catch {
      // not JSON — leave the request untouched
    }
  }
  return fetch(input, init);
};

// Each factory turns provider credentials + a model id into an AI SDK LanguageModel.
// This is the single seam that makes Privateer provider-agnostic: the agent loop,
// tools, and UI never know or care which provider is behind the model.
type Factory = (cfg: ProviderConfig, modelId: string) => LanguageModel;

// Whether a provider requires an API key to be usable (Ollama is local, so it doesn't).
const REQUIRES_KEY: Record<ProviderName, boolean> = {
  openrouter: true,
  anthropic: true,
  openai: true,
  google: true,
  xai: true,
  groq: true,
  mistral: true,
  zai: true,
  moonshot: true,
  cerebras: true,
  deepseek: true,
  minimax: true,
  qwen: true,
  ollama: false,
  nearai: true,
  tinfoil: true,
  venice: true,
  // A custom endpoint may or may not need a key (LM Studio doesn't, a corporate
  // proxy might); its real requirement is the baseURL — see providerReady().
  custom: false,
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
  google: (cfg, modelId) =>
    createGoogleGenerativeAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  xai: (cfg, modelId) =>
    createXai({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  groq: (cfg, modelId) =>
    createGroq({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  mistral: (cfg, modelId) =>
    createMistral({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  zai: (cfg, modelId) =>
    // OpenAI-compatible, Chat-Completions-only — `.chat()` pins the transport
    // like nearai/tinfoil.
    createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? ZAI_BASE_URL }).chat(modelId),
  moonshot: (cfg, modelId) =>
    // The dedicated package (not plain createOpenAI) maps Kimi thinking models'
    // non-standard `reasoning_content` field into AI SDK reasoning parts.
    createMoonshotAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  cerebras: (cfg, modelId) =>
    createCerebras({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  deepseek: (cfg, modelId) =>
    // The dedicated package maps the reasoner mode's non-standard
    // `reasoning_content` field into AI SDK reasoning parts.
    createDeepSeek({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  minimax: (cfg, modelId) =>
    // OpenAI-compatible, Chat-Completions-only — `.chat()` pins the transport
    // like nearai/tinfoil/zai.
    createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? MINIMAX_BASE_URL }).chat(modelId),
  qwen: (cfg, modelId) =>
    // OpenAI-compatible, Chat-Completions-only — `.chat()` pins the transport
    // like nearai/tinfoil/zai/minimax.
    createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? QWEN_BASE_URL }).chat(modelId),
  ollama: (cfg, modelId) =>
    createOllama({ baseURL: cfg.baseURL })(modelId),
  nearai: (cfg, modelId) =>
    // OpenAI-compatible, but Chat-Completions-only — `.chat()` avoids the SDK's
    // default Responses transport, which NEAR's TEE endpoints don't implement.
    createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? NEARAI_BASE_URL }).chat(modelId),
  tinfoil: (cfg, modelId) =>
    // OpenAI-compatible TEE gateway; `.chat()` pins Chat Completions like nearai.
    createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? TINFOIL_BASE_URL }).chat(modelId),
  venice: (cfg, modelId) =>
    // OpenAI-compatible, Chat Completions pinned like nearai/tinfoil; veniceFetch
    // opts out of Venice's injected system prompt.
    createOpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL ?? VENICE_BASE_URL,
      fetch: veniceFetch,
    }).chat(modelId),
  custom: (cfg, modelId) =>
    // User-supplied OpenAI-compatible endpoint. `.chat()` pins Chat Completions —
    // the lowest common denominator every compatible server implements (Responses
    // is OpenAI-proper only). The placeholder key keeps the SDK from demanding
    // OPENAI_API_KEY when the endpoint is keyless; resolveModel guards baseURL.
    createOpenAI({ apiKey: cfg.apiKey ?? "unused", baseURL: cfg.baseURL }).chat(modelId),
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
