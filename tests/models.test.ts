import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { listModels } from "../src/providers/models.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Capture the URL/headers a provider hits and reply with a canned JSON body.
function mockFetch(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
  return calls;
}

test("anthropic listing sends the key + version and maps display names", async () => {
  const calls = mockFetch({
    data: [{ id: "claude-opus-4-8", display_name: "Claude Opus 4.8" }],
  });
  const models = await listModels("anthropic", { apiKey: "sk-ant" });
  assert.deepEqual(models, [{ id: "claude-opus-4-8", label: "Claude Opus 4.8" }]);
  assert.match(calls[0].url, /api\.anthropic\.com\/v1\/models/);
  assert.equal(calls[0].headers["x-api-key"], "sk-ant");
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
});

test("openai listing keeps chat models and sends a bearer token", async () => {
  const calls = mockFetch({
    data: [{ id: "gpt-4o" }, { id: "text-embedding-3-small" }, { id: "o3-mini" }],
  });
  const models = await listModels("openai", { apiKey: "sk-oai" });
  assert.deepEqual(
    models.map((m) => m.id),
    ["gpt-4o", "o3-mini"],
  );
  assert.equal(calls[0].headers.authorization, "Bearer sk-oai");
});

test("openrouter listing works without a key and sorts by id", async () => {
  mockFetch({
    data: [
      { id: "z/model", name: "Z" },
      { id: "a/model", name: "A" },
    ],
  });
  const models = await listModels("openrouter", {});
  assert.deepEqual(
    models.map((m) => m.id),
    ["a/model", "z/model"],
  );
});

test("ollama listing reads local tags off the configured base URL", async () => {
  const calls = mockFetch({ models: [{ name: "llama3.1:8b" }] });
  const models = await listModels("ollama", { baseURL: "http://localhost:11434/api" });
  assert.deepEqual(models, [{ id: "llama3.1:8b" }]);
  assert.match(calls[0].url, /localhost:11434\/api\/tags$/);
});

test("a non-OK response throws with the status", async () => {
  mockFetch({ error: "bad key" }, 401);
  await assert.rejects(() => listModels("anthropic", { apiKey: "nope" }), /401/);
});

test("anthropic listing requires a key", async () => {
  await assert.rejects(() => listModels("anthropic", {}), /no API key/);
});
