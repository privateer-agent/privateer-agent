// PRIVATEER_HOME must point somewhere disposable before the auth module resolves paths
// (globalDir reads it lazily, so setting it here is enough) — guardedWebToolDefinitions
// asks whether this machine is signed in, and must not find the developer's own login.
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-webmode-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveWebMode,
  readWebToolsConfig,
  webToolsConfigPath,
  WEB_MODE_ENV,
  type ProviderMetaLike,
  type WebToolsConfigLike,
} from "../src/tools/webMode.ts";
import { guardedWebToolDefinitions } from "../src/tools/web.ts";

// The shape of rpiv-web-tools' PROVIDERS, trimmed to what the decision reads. Kept as a
// fixture rather than imported so a change in that package shows up as a REAL failure
// here (the decision drifting from its metadata) rather than as a silently-adjusted test.
const PROVIDERS: ProviderMetaLike[] = [
  { name: "brave", envVar: "BRAVE_SEARCH_API_KEY" },
  { name: "tavily", envVar: "TAVILY_API_KEY" },
  { name: "searxng", envVar: "SEARXNG_API_KEY", baseUrlEnvVar: "SEARXNG_URL" },
];

const decide = (config: WebToolsConfigLike, env: Record<string, string | undefined> = {}) =>
  resolveWebMode({ providers: PROVIDERS, config, env });

test("nothing configured — the account route serves a signed-in terminal", () => {
  const d = decide({});
  assert.equal(d.mode, "privateer");
  assert.equal(d.provider, "brave");
});

// The precedence that matters most: a user who went and configured their own provider
// chose it deliberately, and a self-hosted SearXNG is more private than routing through
// our servers. Filling the gap must never mean taking that over (or billing for it).
test("a provider key wins over the account route, from env or from the config file", () => {
  assert.equal(decide({}, { BRAVE_SEARCH_API_KEY: "sk-brave" }).mode, "own");
  assert.equal(decide({ apiKeys: { brave: "sk-brave" } }).mode, "own");
  // The legacy top-level Brave key rpiv-web-tools still honours until its next save.
  assert.equal(decide({ apiKey: "sk-brave" }).mode, "own");
});

test("a key for a provider that isn't the active one doesn't count", () => {
  // rpiv-web-tools resolves the key for the ACTIVE provider only, so a stray TAVILY_API_KEY
  // with `provider` unset leaves it searching Brave with no key — not a configured user.
  assert.equal(decide({}, { TAVILY_API_KEY: "tvly" }).mode, "privateer");
  assert.equal(decide({ provider: "tavily" }, { TAVILY_API_KEY: "tvly" }).mode, "own");
});

test("blank credentials are not credentials", () => {
  assert.equal(decide({ apiKeys: { brave: "   " } }, { BRAVE_SEARCH_API_KEY: "" }).mode, "privateer");
});

test("a self-hosted provider needs no key — selecting it is the whole setup", () => {
  assert.equal(decide({ provider: "searxng" }).mode, "own");
  assert.equal(decide({ provider: "searxng", baseUrls: { searxng: "http://localhost:8888" } }).mode, "own");
});

test("a URL env var alone is not a provider selection", () => {
  // Deliberate: Ollama's base-URL var is OLLAMA_HOST, set on any machine running a local
  // model for reasons unrelated to search. Reading it as intent would hand that user
  // rpiv-web-tools with its unconfigured default provider — a terminal whose every search
  // fails — instead of the account search they can actually use.
  assert.equal(decide({}, { SEARXNG_URL: "http://localhost:8888" }).mode, "privateer");
  assert.equal(decide({ baseUrls: { searxng: "http://localhost:8888" } }).mode, "privateer");
});

test("an unrecognised provider is left to rpiv-web-tools to report", () => {
  // A newer version of that package than the metadata we were handed, or a typo. Either
  // way the user made a choice about their own provider; we must not silently override it.
  const d = decide({ provider: "kagi" });
  assert.equal(d.mode, "own");
  assert.match(d.reason, /unrecognised/);
});

test("no provider metadata at all — the pack is missing, so nothing is configured", () => {
  // The launcher drops a shim whose target didn't resolve, so this is a real state.
  const d = resolveWebMode({ providers: [], config: { apiKeys: { brave: "sk" } }, env: {} });
  assert.equal(d.mode, "own", "a key still reads as configured — the key map needs no metadata");
  assert.equal(resolveWebMode({ providers: [], config: {}, env: {} }).mode, "privateer");
});

test("the escape hatches pin a route in both directions", () => {
  // Holds a key, wants the account path anyway.
  assert.equal(decide({ apiKeys: { brave: "sk" } }, { [WEB_MODE_ENV]: "privateer" }).mode, "privateer");
  assert.equal(decide({ provider: "privateer" }, { BRAVE_SEARCH_API_KEY: "sk" }).mode, "privateer");
  assert.equal(decide({ provider: "PRIVATEER" }).mode, "privateer");
  // Signed in with nothing configured, but wants their own provider regardless — they get
  // rpiv-web-tools' own "run /web-tools" prompt, which is the right answer for that ask.
  assert.equal(decide({}, { [WEB_MODE_ENV]: "own" }).mode, "own");
  // An unrelated value is ignored rather than treated as a route.
  assert.equal(decide({}, { [WEB_MODE_ENV]: "yes" }).mode, "privateer");
});

test("the config path is rpiv-web-tools' own, and a broken file reads as nothing configured", () => {
  assert.match(webToolsConfigPath(), /\.config[/\\]rpiv-web-tools[/\\]config\.json$/);

  const dir = mkdtempSync(join(tmpdir(), "pv-webmode-"));
  try {
    const path = join(dir, "config.json");
    assert.deepEqual(readWebToolsConfig(join(dir, "absent.json")), {});
    writeFileSync(path, "{ not json");
    assert.deepEqual(readWebToolsConfig(path), {}, "malformed JSON must not decide the route by throwing");
    writeFileSync(path, '["an", "array"]');
    assert.deepEqual(readWebToolsConfig(path), {});
    writeFileSync(path, '{"provider":"tavily","apiKeys":{"tavily":"tvly"}}');
    assert.equal(readWebToolsConfig(path).provider, "tavily");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The interactive half of the account route: the session outlives the sign-in decision, so
// the check has to happen per call. Signed out, that must be an answer the user can act on
// — not a network round trip that comes back 401.
test("the account tools tell a signed-out terminal how to fix it, without calling out", async () => {
  const savedFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("the signed-out guard must not reach the network");
  }) as any;
  try {
    const [search, fetchTool] = guardedWebToolDefinitions("HINT: run /signin") as any[];
    assert.deepEqual([search.name, fetchTool.name], ["web_search", "web_fetch"]);
    for (const [def, params] of [
      [search, { query: "when is the next full moon" }],
      [fetchTool, { url: "https://example.com" }],
    ] as const) {
      const res = await def.execute("call-1", params);
      assert.match(res.content[0].text, /HINT: run \/signin/);
    }
    assert.equal(called, false);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
