import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { generateModelsJson, writeModelsJson } from "../src/providers/genModelsJson.ts";
import { providersToGenerate, PROVIDER_BY_ID } from "../src/providers/catalog.ts";

// Pure (no Pi import) so it runs on Node 20 too. Live registry resolution is
// checked separately via a probe (needs Node 22 + pi-coding-agent).

test("only config-only providers are generated (qwen today)", () => {
  assert.deepEqual(providersToGenerate().map((p) => p.id), ["qwen"]);
});

test("built-ins and privacy providers are NOT emitted", () => {
  const gen = generateModelsJson();
  assert.equal(gen.providers.openrouter, undefined); // pi built-in
  assert.equal(gen.providers.tinfoil, undefined); // pi-privacy
  assert.equal(gen.providers.venice, undefined); // pi-privacy
  assert.equal(gen.providers.privateer, undefined); // account channel (code)
  assert.ok(gen.providers.qwen);
});

test("qwen entry uses an env template key, never a literal", () => {
  const q = generateModelsJson().providers.qwen;
  assert.equal(q.apiKey, "${DASHSCOPE_API_KEY}");
  assert.equal(q.authHeader, true);
  assert.equal(q.baseUrl, PROVIDER_BY_ID.qwen.baseUrl);
  assert.equal(q.api, "openai-completions");
  assert.deepEqual(q.compat, { thinkingFormat: "qwen" });
  assert.ok(q.models.some((m) => m.id === "qwen3-max"));
  // Day-one seed (2026-08-03) leads with its real ~1M window (SEED_CONTEXT override).
  assert.equal(q.models[0].id, "qwen3.8-max-preview");
  assert.equal(q.models[0].contextWindow, 1_000_000);
  // A.4 defaults for everything without an override
  const qwen3max = q.models.find((m) => m.id === "qwen3-max")!;
  assert.equal(qwen3max.contextWindow, 128000);
  assert.equal(qwen3max.maxTokens, 16384);
  assert.deepEqual(qwen3max.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("writeModelsJson merges without clobbering existing providers", () => {
  const path = "/private/tmp/claude-501/pv-models-test/models.json";
  mkdirSync("/private/tmp/claude-501/pv-models-test", { recursive: true });
  // Pre-existing file with a user/extension provider.
  writeFileSync(
    path,
    JSON.stringify({ providers: { openrouter: { name: "OpenRouter", baseUrl: "x", api: "openai-completions", models: [] } } }),
  );
  const merged = writeModelsJson(generateModelsJson(), path);
  assert.ok(merged.providers.openrouter, "existing provider preserved");
  assert.ok(merged.providers.qwen, "generated provider added");
  // Round-trips to disk.
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(onDisk.providers.openrouter && onDisk.providers.qwen);
  rmSync("/private/tmp/claude-501/pv-models-test", { recursive: true, force: true });
});
