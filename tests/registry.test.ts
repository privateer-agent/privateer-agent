import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../src/providers/registry.ts";

// The OpenRouter model object carries the per-request settings it was built with,
// so we can assert that ZDR enforcement actually attaches provider.zdr (the flag
// that pins routing to zero-data-retention endpoints) — and only when asked.
test("openrouter buildModel pins provider.zdr when enforceZdr is set", () => {
  const model = buildModel("openrouter", { apiKey: "sk-or", enforceZdr: true }, "openai/gpt-4o");
  assert.equal((model as any).settings?.provider?.zdr, true);
});

test("openrouter buildModel leaves routing unpinned by default", () => {
  const model = buildModel("openrouter", { apiKey: "sk-or" }, "openai/gpt-4o");
  assert.equal((model as any).settings?.provider?.zdr, undefined);
});

// Construction is offline for every provider, so a smoke test catches a factory
// that's miswired (wrong SDK import, bad default base) without touching the network.
test("buildModel constructs a model for each new provider", () => {
  for (const [provider, id] of [
    ["google", "gemini-3.5-flash"],
    ["xai", "grok-4.3"],
    ["groq", "llama-3.3-70b-versatile"],
    ["mistral", "mistral-large-latest"],
    ["zai", "glm-5"],
    ["moonshot", "kimi-k2.7-code"],
    ["cerebras", "gpt-oss-120b"],
    ["deepseek", "deepseek-v4-flash"],
    ["minimax", "MiniMax-M3"],
    ["tinfoil", "deepseek-v4-pro"],
  ] as const) {
    const model = buildModel(provider, { apiKey: "test-key" }, id);
    assert.equal((model as any).modelId, id, `${provider} model id passthrough`);
  }
});

test("custom buildModel works keyless against a user-supplied endpoint", () => {
  const model = buildModel("custom", { baseURL: "http://localhost:1234/v1" }, "qwen3-coder");
  assert.equal((model as any).modelId, "qwen3-coder");
});
