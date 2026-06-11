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
