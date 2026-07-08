import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createXai } from "@ai-sdk/xai";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createMoonshotAI } from "@ai-sdk/moonshotai";
import { createCerebras } from "@ai-sdk/cerebras";
import { createFireworks } from "@ai-sdk/fireworks";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createOllama } from "ollama-ai-provider-v2";
import type { ProviderConfig, ProviderName } from "../config/schema.ts";
import { authedFetch, serverBaseUrl } from "../auth/privateer.ts";

// NEAR AI Cloud's OpenAI-compatible gateway. Every model behind it runs inside a
// Trusted Execution Environment (TEE), so requests are confidential and each one
// can be cryptographically attested (see ./attestation.ts). It only implements the
// Chat Completions API — served by the `compatChat` builder below, which supplies
// this base when the user hasn't set one.
export const NEARAI_BASE_URL = "https://cloud-api.near.ai/v1";

// Tinfoil's OpenAI-compatible inference gateway. Like NEAR AI, every model runs
// inside a hardware enclave (TEE) — prompts are confidential to the host. The
// gateway publishes a per-host attestation document that /verify and the status-bar
// shield check, TLS-key-bound to the connection (see ./attestation.ts).
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

// Shared builder for Chat-Completions-only OpenAI-compatible endpoints
// (nearai/tinfoil/zai/minimax/qwen/venice/custom/privateer). Two things matter here:
// - `createOpenAICompatible`, NOT plain `createOpenAI(...).chat()`: only the compat
//   package maps the non-standard `reasoning_content` stream field — which DeepSeek/
//   GLM/Kimi-style thinking models emit — into AI SDK reasoning parts. Plain
//   createOpenAI silently drops it, so a reasoning model looked hung (no output,
//   0 tokens) for its entire thinking phase.
// - `includeUsage: true`: the compat package omits `stream_options.include_usage`
//   unless asked (createOpenAI always sent it), and per-step token usage — the live
//   counter and context tracking — depends on it.
const compatChat = (
  modelId: string,
  opts: { name: string; baseURL: string; apiKey?: string; fetch?: typeof fetch },
) => createOpenAICompatible({ ...opts, includeUsage: true }).chatModel(modelId);

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
  fireworks: true,
  together: true,
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
    compatChat(modelId, { name: "zai", apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? ZAI_BASE_URL }),
  moonshot: (cfg, modelId) =>
    // The dedicated package (not plain createOpenAI) maps Kimi thinking models'
    // non-standard `reasoning_content` field into AI SDK reasoning parts.
    createMoonshotAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  cerebras: (cfg, modelId) =>
    createCerebras({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  fireworks: (cfg, modelId) =>
    // Open models run zero-data-retention by default (volatile memory only); the
    // dedicated package supplies the inference base URL and key header.
    createFireworks({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  together: (cfg, modelId) =>
    // ZDR exists but only as an account-level setting the client can't verify —
    // see the catalog keyHint / README note for the honest copy.
    createTogetherAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  deepseek: (cfg, modelId) =>
    // The dedicated package maps the reasoner mode's non-standard
    // `reasoning_content` field into AI SDK reasoning parts.
    createDeepSeek({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })(modelId),
  minimax: (cfg, modelId) =>
    compatChat(modelId, { name: "minimax", apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? MINIMAX_BASE_URL }),
  qwen: (cfg, modelId) =>
    compatChat(modelId, { name: "qwen", apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? QWEN_BASE_URL }),
  ollama: (cfg, modelId) =>
    createOllama({ baseURL: cfg.baseURL })(modelId),
  nearai: (cfg, modelId) =>
    compatChat(modelId, { name: "nearai", apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? NEARAI_BASE_URL }),
  tinfoil: (cfg, modelId) =>
    compatChat(modelId, { name: "tinfoil", apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? TINFOIL_BASE_URL }),
  venice: (cfg, modelId) =>
    // veniceFetch opts out of Venice's injected system prompt.
    compatChat(modelId, {
      name: "venice",
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL ?? VENICE_BASE_URL,
      fetch: veniceFetch,
    }),
  custom: (cfg, modelId) =>
    // User-supplied OpenAI-compatible endpoint. apiKey is optional here (LM Studio
    // and friends are keyless — no placeholder needed); resolveModel guards baseURL,
    // and the catalog's baseURLDefault backstops it.
    compatChat(modelId, { name: "custom", apiKey: cfg.apiKey, baseURL: cfg.baseURL ?? "http://localhost:1234/v1" }),
  privateer: (cfg, modelId) =>
    // Routes to the Privateer server's billed, OpenAI-compatible agent endpoint.
    // `authedFetch` injects the account JWT (replacing any Authorization header)
    // and refreshes it on 401, so no apiKey is configured. The modelId is a normal
    // OpenRouter id, resolved and billed server-side. Base URL: cfg override →
    // account server → default.
    compatChat(modelId, {
      name: "privateer",
      baseURL: `${(cfg.baseURL ?? serverBaseUrl()).replace(/\/$/, "")}/api/agent/v1`,
      fetch: authedFetch as typeof fetch,
    }),
};

export function providerRequiresKey(name: ProviderName): boolean {
  return REQUIRES_KEY[name];
}

export function buildModel(name: ProviderName, cfg: ProviderConfig, modelId: string): LanguageModel {
  return FACTORIES[name](cfg, modelId);
}
