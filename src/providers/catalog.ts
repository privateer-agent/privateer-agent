// The provider landscape — the single map of how each of privateer's 21 providers
// becomes reachable under Pi. Written after verifying (2026-07-07) that:
//   - pi-ai ships STATIC model catalogs for its 14 built-in providers, so they're
//     selectable once a key is present — privateer emits NO models.json entry for them;
//   - the `pi-privacy` extension registers the 5 privacy providers (tinfoil, nearai,
//     venice, ollama, custom) at load — privateer emits NO entry for them either;
//   - so the ONLY provider this generator must emit is `qwen` (config-only,
//     non-privacy, no built-in catalog), and `privateer` (the account OAuth channel)
//     is handled in code, not config (Phase 4).
//
// The plan (Appendix A) assumed we'd generate the whole models.json; Pi's built-in
// catalogs + pi-privacy made most of that redundant. This map keeps the accounting
// explicit so nothing silently falls through.

export type ProviderSource =
  | "pi-builtin" // pi-ai ships the provider + its model catalog (needs only a key)
  | "pi-privacy" // registered by the pi-privacy extension at load
  | "generate" // privateer must emit a models.json entry (config-only, no built-in)
  | "account"; // the privateer account channel — OAuth in code, not config

export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface ProviderEntry {
  id: string;
  source: ProviderSource;
  // For `generate` providers: the config a models.json entry needs.
  baseUrl?: string;
  api?: ProviderApi;
  keyEnv?: string; // env template ${...}; Pi resolves it (or auth.json wins)
  compat?: Record<string, unknown>;
  seedModels?: string[]; // provisional ids until live listing refines them
  // Optional nuance override for a built-in (api/compat differs from pi-ai default).
  // Not emitted yet — overriding a built-in can drop its model catalog; revisit once
  // Pi's override-merge semantics are confirmed. Documented here so it's not lost.
  overrideNote?: string;
}

// Ordered like KNOWN_PROVIDERS (tree-cli schema.ts) for a stable picker order.
export const PROVIDERS: ProviderEntry[] = [
  { id: "openrouter", source: "pi-builtin", overrideNote: "ZDR routing handled by pi-privacy" },
  { id: "anthropic", source: "pi-builtin" },
  { id: "openai", source: "pi-builtin", overrideNote: "0.2 used chat-completions, not responses" },
  { id: "google", source: "pi-builtin" },
  { id: "xai", source: "pi-builtin" },
  { id: "groq", source: "pi-builtin" },
  { id: "mistral", source: "pi-builtin" },
  { id: "zai", source: "pi-builtin", overrideNote: "0.2 baseUrl …/api/paas/v4; compat.thinkingFormat zai" },
  { id: "moonshot", source: "pi-builtin" },
  { id: "cerebras", source: "pi-builtin" },
  { id: "fireworks", source: "pi-builtin" },
  { id: "together", source: "pi-builtin", overrideNote: "compat.thinkingFormat together" },
  { id: "deepseek", source: "pi-builtin", overrideNote: "compat.thinkingFormat deepseek" },
  { id: "minimax", source: "pi-builtin", overrideNote: "0.2 used …/v1 openai-compat, not anthropic-messages" },
  {
    id: "qwen",
    source: "generate",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    api: "openai-completions",
    keyEnv: "${DASHSCOPE_API_KEY}",
    compat: { thinkingFormat: "qwen" },
    seedModels: ["qwen3-max", "qwen3-coder-plus", "qwen-max-latest"],
  },
  { id: "ollama", source: "pi-privacy" },
  { id: "nearai", source: "pi-privacy" },
  { id: "tinfoil", source: "pi-privacy" },
  { id: "venice", source: "pi-privacy" },
  { id: "custom", source: "pi-privacy" },
  { id: "privateer", source: "account" },
];

export const PROVIDER_BY_ID: Record<string, ProviderEntry> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p]),
);

// Providers this generator is responsible for emitting into models.json.
export function providersToGenerate(): ProviderEntry[] {
  return PROVIDERS.filter((p) => p.source === "generate");
}
