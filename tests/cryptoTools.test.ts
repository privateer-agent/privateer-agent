// PRIVATEER_HOME must point somewhere disposable before the auth module resolves
// paths (globalDir reads it lazily, so setting it here is enough).
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-cryptotools-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { cryptoLookupToolDefinition, guardedCryptoToolDefinitions, CRYPTO_TOOL_NAMES } from "../src/tools/crypto.ts";
import { classifyToolCall } from "../src/permissions/classify.ts";
import { saveCredentials, clearCredentials } from "../src/auth/privateer.ts";

const SERVER = "https://acct.example.com";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

interface Call {
  url: string;
  body: any;
}

/** Same harness as webTools.test.ts: credentials saved, fetch stubbed, spawn hop answered. */
async function withStub(
  reply: (url: string, body: any) => Response,
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const savedFetch = globalThis.fetch;
  const savedEnv = process.env.PRIVATEER_SERVER_URL;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.endsWith("/auth/session/spawn")) {
      return new Response(JSON.stringify({ accessToken: "child-at", refreshToken: "child-rt" }), { status: 200 });
    }
    let body: any;
    try {
      body = init.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ url, body });
    return reply(url, body);
  }) as typeof fetch;
  try {
    process.env.PRIVATEER_SERVER_URL = SERVER;
    saveCredentials({
      accessToken: "parent-at",
      refreshToken: "parent-rt",
      user: { id: "u1", email: "a@b.co", solanaPublicKey: null, kekSource: null },
      serverBaseUrl: SERVER,
    });
    await fn(calls);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEnv === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = savedEnv;
    clearCredentials();
  }
}

const out = (r: any): string => r.content[0].text;
const ok = (text: string) => new Response(JSON.stringify({ found: true, text }), { status: 200 });

test("tokens mode sends only the tickers, raw, and returns the server's block", async () => {
  await withStub(
    () => ok("[Live crypto market data]\n1. SOL — Price $123.40\nLinks:\n  [1] https://dexscreener.com/solana/x"),
    async (calls) => {
      const r = await cryptoLookupToolDefinition.execute("t1", { query: "SOL, BONK" });
      assert.equal(calls[0].url, `${SERVER}/api/rag/crypto`);
      assert.deepEqual(calls[0].body, { mode: "tokens", raw: true, query: "SOL, BONK" });
      assert.match(out(r), /\$123\.40/);
      assert.match(out(r), /https:\/\/dexscreener\.com/);
    },
  );
});

test("portfolio without an address sends NO address — the server reads the account's own wallet", async () => {
  await withStub(() => ok("[Live Solana wallet holdings]"), async (calls) => {
    await cryptoLookupToolDefinition.execute("t2", { mode: "portfolio" });
    assert.deepEqual(calls[0].body, { mode: "portfolio", raw: true });
  });
});

test("portfolio with a pasted address passes it; a non-Solana address is refused locally", async () => {
  await withStub(() => ok("[Live Solana wallet holdings]"), async (calls) => {
    await cryptoLookupToolDefinition.execute("t3", { mode: "portfolio", address: WALLET });
    assert.equal(calls[0].body.address, WALLET);

    const bad = await cryptoLookupToolDefinition.execute("t4", { mode: "portfolio", address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933" });
    assert.match(out(bad), /must be a Solana wallet address/);
    assert.equal(calls.length, 1, "the refused call never reached the server");
  });
});

test("discovery modes carry the chain as its own field", async () => {
  await withStub(() => ok("[Newest token profiles]"), async (calls) => {
    await cryptoLookupToolDefinition.execute("t5", { mode: "new", chain: "Solana" });
    assert.deepEqual(calls[0].body, { mode: "new", raw: true, chain: "solana" });
  });
});

test("tokens mode requires a query without calling the server", async () => {
  await withStub(() => ok("x"), async (calls) => {
    const r = await cryptoLookupToolDefinition.execute("t6", {});
    assert.match(out(r), /query is required/);
    assert.equal(calls.length, 0);
  });
});

test("nothing found says so and points at web_search, rather than inventing a price", async () => {
  await withStub(() => new Response(JSON.stringify({ found: false, text: "" }), { status: 200 }), async () => {
    const r = await cryptoLookupToolDefinition.execute("t7", { query: "NOTACOIN" });
    assert.match(out(r), /No DEX market found for NOTACOIN/);
    assert.match(out(r), /web_search/);
  });
});

test("server refusals come back as words", async () => {
  await withStub(
    () => new Response(JSON.stringify({ error: { code: "CRYPTO_FAILED", message: "Market data lookup failed" } }), { status: 502 }),
    async () => {
      const r = await cryptoLookupToolDefinition.execute("t8", { query: "SOL" });
      assert.match(out(r), /Crypto lookup failed/);
      assert.match(out(r), /HTTP 502/);
    },
  );
});

test("the guarded form answers a signed-out session with the hint, not a request", async () => {
  clearCredentials();
  const [def] = guardedCryptoToolDefinitions("HINT: run /signin") as any[];
  const r = await def.execute("t9", { query: "SOL" });
  assert.equal(out(r), "HINT: run /signin");
});

test("CRYPTO_TOOL_NAMES matches what the definition registers", () => {
  assert.deepEqual([...CRYPTO_TOOL_NAMES], [cryptoLookupToolDefinition.name]);
});

// ── the permission gate ──────────────────────────────────────────────────────

const scope = { cwd: "/work", extraDirs: [] as string[] };

test("crypto_lookup classifies as a network read, not an unknown bash-kind call", () => {
  // The unknown-tool branch would DENY this in plan/readonly; a fetch asks.
  const req = classifyToolCall("crypto_lookup", { query: "SOL, BONK" }, scope as any);
  assert.equal(req?.kind, "fetch");
  assert.equal(req?.detail, "SOL, BONK");

  const own = classifyToolCall("crypto_lookup", { mode: "portfolio" }, scope as any);
  assert.match(own!.detail, /account's own Solana wallet/);
});
