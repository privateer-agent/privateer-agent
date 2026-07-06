import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  listModels,
  fetchZdrAccount,
  zdrPosture,
  type ZdrAccountData,
} from "../src/providers/models.ts";

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

test("nearai listing hits the OpenAI-compatible models endpoint with a bearer token", async () => {
  const calls = mockFetch({ data: [{ id: "Qwen/Qwen3.5-122B" }, { id: "zai-org/GLM-5.1-FP8" }] });
  const models = await listModels("nearai", { apiKey: "near-key" });
  assert.deepEqual(
    models.map((m) => m.id),
    ["Qwen/Qwen3.5-122B", "zai-org/GLM-5.1-FP8"],
  );
  assert.match(calls[0].url, /cloud-api\.near\.ai\/v1\/models$/);
  assert.equal(calls[0].headers.authorization, "Bearer near-key");
});

test("nearai listing requires a key", async () => {
  await assert.rejects(() => listModels("nearai", {}), /no API key/);
});

test("google listing sends the key header, keeps generateContent models, strips the prefix", async () => {
  const calls = mockFetch({
    models: [
      {
        name: "models/gemini-3.5-flash",
        displayName: "Gemini 3.5 Flash",
        supportedGenerationMethods: ["generateContent"],
      },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
    ],
  });
  const models = await listModels("google", { apiKey: "AIza-test" });
  assert.deepEqual(models, [{ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" }]);
  assert.match(calls[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models/);
  assert.equal(calls[0].headers["x-goog-api-key"], "AIza-test");
});

test("google listing requires a key", async () => {
  await assert.rejects(() => listModels("google", {}), /no API key/);
});

test("xai and groq list via the OpenAI shape with a bearer token", async () => {
  const calls = mockFetch({ data: [{ id: "grok-4.3" }, { id: "grok-build-0.1" }] });
  const xai = await listModels("xai", { apiKey: "xai-key" });
  assert.deepEqual(
    xai.map((m) => m.id),
    ["grok-4.3", "grok-build-0.1"],
  );
  assert.match(calls[0].url, /api\.x\.ai\/v1\/models$/);
  assert.equal(calls[0].headers.authorization, "Bearer xai-key");

  const groqCalls = mockFetch({ data: [{ id: "llama-3.3-70b-versatile" }] });
  const groq = await listModels("groq", { apiKey: "gsk_key" });
  assert.deepEqual(groq, [{ id: "llama-3.3-70b-versatile" }]);
  assert.match(groqCalls[0].url, /api\.groq\.com\/openai\/v1\/models$/);
  assert.equal(groqCalls[0].headers.authorization, "Bearer gsk_key");
});

test("xai and groq listings require a key", async () => {
  await assert.rejects(() => listModels("xai", {}), /no API key/);
  await assert.rejects(() => listModels("groq", {}), /no API key/);
});

test("zai lists via the OpenAI shape against the Z.ai endpoint", async () => {
  const calls = mockFetch({ data: [{ id: "glm-5" }, { id: "glm-4.7" }] });
  const models = await listModels("zai", { apiKey: "zai-key" });
  assert.deepEqual(
    models.map((m) => m.id),
    ["glm-4.7", "glm-5"],
  );
  assert.match(calls[0].url, /api\.z\.ai\/api\/paas\/v4\/models$/);
  assert.equal(calls[0].headers.authorization, "Bearer zai-key");
});

test("zai listing requires a key", async () => {
  await assert.rejects(() => listModels("zai", {}), /no API key/);
});

test("moonshot lists via the OpenAI shape against the Moonshot endpoint", async () => {
  const calls = mockFetch({ data: [{ id: "kimi-k2.7-code" }, { id: "kimi-k2.6" }] });
  const models = await listModels("moonshot", { apiKey: "sk-kimi" });
  assert.deepEqual(
    models.map((m) => m.id),
    ["kimi-k2.6", "kimi-k2.7-code"],
  );
  assert.match(calls[0].url, /api\.moonshot\.ai\/v1\/models$/);
  assert.equal(calls[0].headers.authorization, "Bearer sk-kimi");
});

test("moonshot listing requires a key", async () => {
  await assert.rejects(() => listModels("moonshot", {}), /no API key/);
});

test("cerebras lists via the OpenAI shape against the Cerebras endpoint", async () => {
  const calls = mockFetch({ data: [{ id: "zai-glm-4.7" }, { id: "gpt-oss-120b" }] });
  const models = await listModels("cerebras", { apiKey: "csk-key" });
  assert.deepEqual(
    models.map((m) => m.id),
    ["gpt-oss-120b", "zai-glm-4.7"],
  );
  assert.match(calls[0].url, /api\.cerebras\.ai\/v1\/models$/);
  assert.equal(calls[0].headers.authorization, "Bearer csk-key");
});

test("cerebras listing requires a key", async () => {
  await assert.rejects(() => listModels("cerebras", {}), /no API key/);
});

test("deepseek lists via the OpenAI shape against the DeepSeek endpoint", async () => {
  const calls = mockFetch({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }] });
  const models = await listModels("deepseek", { apiKey: "sk-ds" });
  assert.deepEqual(
    models.map((m) => m.id),
    ["deepseek-v4-flash", "deepseek-v4-pro"],
  );
  assert.match(calls[0].url, /api\.deepseek\.com\/models$/);
  assert.equal(calls[0].headers.authorization, "Bearer sk-ds");
});

test("deepseek listing requires a key", async () => {
  await assert.rejects(() => listModels("deepseek", {}), /no API key/);
});

test("minimax lists via the OpenAI shape against the MiniMax intl endpoint", async () => {
  const calls = mockFetch({ data: [{ id: "MiniMax-M3" }, { id: "MiniMax-M2.7" }] });
  const models = await listModels("minimax", { apiKey: "sk-mm" });
  assert.deepEqual(
    models.map((m) => m.id),
    ["MiniMax-M2.7", "MiniMax-M3"],
  );
  assert.match(calls[0].url, /api\.minimax\.io\/v1\/models$/);
  assert.equal(calls[0].headers.authorization, "Bearer sk-mm");
});

test("minimax listing requires a key", async () => {
  await assert.rejects(() => listModels("minimax", {}), /no API key/);
});

test("qwen lists via the OpenAI shape against the DashScope intl endpoint", async () => {
  const calls = mockFetch({ data: [{ id: "qwen3.7-max" }, { id: "qwen3-coder-plus" }] });
  const models = await listModels("qwen", { apiKey: "sk-qw" });
  assert.deepEqual(
    models.map((m) => m.id),
    ["qwen3-coder-plus", "qwen3.7-max"],
  );
  assert.match(calls[0].url, /dashscope-intl\.aliyuncs\.com\/compatible-mode\/v1\/models$/);
  assert.equal(calls[0].headers.authorization, "Bearer sk-qw");
});

test("qwen listing requires a key", async () => {
  await assert.rejects(() => listModels("qwen", {}), /no API key/);
});

test("mistral listing keeps chat models, maps vision, sends a bearer token", async () => {
  const calls = mockFetch({
    data: [
      { id: "mistral-large-latest", capabilities: { completion_chat: true } },
      { id: "pixtral-large-latest", capabilities: { completion_chat: true, vision: true } },
      { id: "mistral-embed", capabilities: { completion_chat: false } },
    ],
  });
  const models = await listModels("mistral", { apiKey: "mistral-key" });
  assert.deepEqual(models, [
    { id: "mistral-large-latest", inputModalities: undefined },
    { id: "pixtral-large-latest", inputModalities: ["text", "image"] },
  ]);
  assert.match(calls[0].url, /api\.mistral\.ai\/v1\/models$/);
  assert.equal(calls[0].headers.authorization, "Bearer mistral-key");
});

test("mistral listing requires a key", async () => {
  await assert.rejects(() => listModels("mistral", {}), /no API key/);
});

test("custom listing hits the configured endpoint, key optional", async () => {
  const calls = mockFetch({ data: [{ id: "qwen3-coder" }, { id: "glm-air" }] });
  const models = await listModels("custom", { baseURL: "http://localhost:1234/v1" });
  assert.deepEqual(
    models.map((m) => m.id),
    ["glm-air", "qwen3-coder"],
  );
  assert.match(calls[0].url, /localhost:1234\/v1\/models$/);
  assert.equal(calls[0].headers.authorization, undefined);

  const authed = mockFetch({ data: [{ id: "proxy-model" }] });
  await listModels("custom", { baseURL: "https://llm.corp.example/v1", apiKey: "corp-key" });
  assert.equal(authed[0].headers.authorization, "Bearer corp-key");
});

test("custom listing requires a base URL", async () => {
  await assert.rejects(() => listModels("custom", {}), /no base URL/);
});

test("tinfoil listing keeps chat models and maps the multimodal flag to an image modality", async () => {
  const calls = mockFetch({
    data: [
      { id: "kimi-k2-6", type: "chat", multimodal: true },
      { id: "deepseek-v4-pro", type: "chat", multimodal: false },
      { id: "whisper-large-v3-turbo", type: "audio" },
      { id: "nomic-embed-text", type: "embedding" },
    ],
  });
  const models = await listModels("tinfoil", { apiKey: "tk-key" });
  assert.deepEqual(models, [
    { id: "deepseek-v4-pro", inputModalities: undefined },
    { id: "kimi-k2-6", inputModalities: ["text", "image"] },
  ]);
  assert.match(calls[0].url, /inference\.tinfoil\.sh\/v1\/models$/);
  assert.equal(calls[0].headers.authorization, "Bearer tk-key");
});

test("a non-OK response throws with the status", async () => {
  mockFetch({ error: "bad key" }, 401);
  await assert.rejects(() => listModels("anthropic", { apiKey: "nope" }), /401/);
});

test("anthropic listing requires a key", async () => {
  await assert.rejects(() => listModels("anthropic", {}), /no API key/);
});

// ── ZDR posture ──────────────────────────────────────────────────────────────

// Reply with a different body depending on which endpoint the URL hits, so the two
// concurrent calls in fetchZdrAccount get their own shape.
function mockFetchByUrl(bodies: { zdr: unknown; user: unknown }, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    calls.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> });
    const body = u.includes("/endpoints/zdr") ? bodies.zdr : bodies.user;
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

test("fetchZdrAccount hits both endpoints with a bearer token and builds the sets", async () => {
  const calls = mockFetchByUrl({
    zdr: { data: [{ model_id: "anthropic/claude-opus-4.8" }, { model_id: "openai/gpt-4o" }] },
    user: { data: [{ id: "anthropic/claude-opus-4.8" }, { id: "openai/gpt-4o" }] },
  });
  const acct = await fetchZdrAccount({ apiKey: "sk-or" });
  assert.ok(calls.some((c) => c.url.endsWith("/endpoints/zdr")));
  assert.ok(calls.some((c) => c.url.endsWith("/models/user")));
  for (const c of calls) assert.equal(c.headers.authorization, "Bearer sk-or");
  assert.ok(acct.zdrModelIds.has("anthropic/claude-opus-4.8"));
  assert.ok(acct.userModelIds.has("openai/gpt-4o"));
});

test("fetchZdrAccount requires a key", async () => {
  await assert.rejects(() => fetchZdrAccount({}), /no API key/);
});

test("fetchZdrAccount propagates a non-OK status", async () => {
  mockFetchByUrl({ zdr: { error: "bad key" }, user: { error: "bad key" } }, 401);
  await assert.rejects(() => fetchZdrAccount({ apiKey: "nope" }), /401/);
});

test("zdrPosture: red when the model is blocked by the user's settings", () => {
  const acct: ZdrAccountData = {
    zdrModelIds: new Set(["openai/gpt-4o"]),
    userModelIds: new Set([]),
  };
  assert.equal(zdrPosture("openai/gpt-4o", acct, true), "red");
});

test("zdrPosture: red when the model has no ZDR endpoint", () => {
  const acct: ZdrAccountData = {
    zdrModelIds: new Set([]),
    userModelIds: new Set(["openai/gpt-4o"]),
  };
  assert.equal(zdrPosture("openai/gpt-4o", acct, true), "red");
});

test("zdrPosture: green when usable, ZDR-capable, and the client enforces ZDR", () => {
  const acct: ZdrAccountData = {
    zdrModelIds: new Set(["openai/gpt-4o"]),
    userModelIds: new Set(["openai/gpt-4o"]),
  };
  assert.equal(zdrPosture("openai/gpt-4o", acct, true), "green");
});

test("zdrPosture: yellow when ZDR is available but the client doesn't enforce it", () => {
  const acct: ZdrAccountData = {
    zdrModelIds: new Set(["openai/gpt-4o"]),
    userModelIds: new Set(["openai/gpt-4o"]),
  };
  assert.equal(zdrPosture("openai/gpt-4o", acct, false), "yellow");
});

test("zdrPosture: variant suffixes and case are normalized before matching", () => {
  const acct: ZdrAccountData = {
    zdrModelIds: new Set(["openai/gpt-4o"]),
    userModelIds: new Set(["openai/gpt-4o"]),
  };
  assert.equal(zdrPosture("OpenAI/GPT-4o:free", acct, true), "green");
});
