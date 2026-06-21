import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the global dir at a throwaway home BEFORE importing the module, since
// credential paths derive from PRIVATEER_HOME lazily.
const home = mkdtempSync(join(tmpdir(), "priv-auth-"));
process.env.PRIVATEER_HOME = home;
delete process.env.PRIVATEER_SERVER_URL;

const {
  saveCredentials,
  loadCredentials,
  clearCredentials,
  hasCredentials,
  currentUser,
  serverBaseUrl,
  isSafeServerUrl,
  DEFAULT_SERVER_URL,
  defaultDeviceLabel,
  authedFetch,
} = await import("../src/auth/privateer.ts");

const creds = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  user: { id: "u1", email: "a@b.co", solanaPublicKey: null, kekSource: "password" },
  serverBaseUrl: "https://example.test",
};

test("credentials roundtrip: save, load, clear", () => {
  assert.equal(hasCredentials(), false, "starts logged out");

  saveCredentials(creds);
  assert.equal(hasCredentials(), true);
  assert.deepEqual(loadCredentials(), creds);
  assert.equal(currentUser()?.email, "a@b.co");

  // File is written owner-only (0600) where the platform honors POSIX modes.
  const path = join(home, "credentials.json");
  assert.ok(existsSync(path));
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }

  clearCredentials();
  assert.equal(hasCredentials(), false);
  assert.equal(loadCredentials(), null);
});

test("serverBaseUrl: env override beats stored beats default", () => {
  clearCredentials();
  assert.equal(serverBaseUrl(), DEFAULT_SERVER_URL, "default when no creds, no env");

  saveCredentials(creds);
  assert.equal(serverBaseUrl(), "https://example.test", "stored when present");

  process.env.PRIVATEER_SERVER_URL = "https://dev.local/";
  assert.equal(serverBaseUrl(), "https://dev.local", "env wins (trailing slash trimmed)");
  delete process.env.PRIVATEER_SERVER_URL;
  clearCredentials();
});

test("defaultDeviceLabel is a non-empty user@host string", () => {
  const label = defaultDeviceLabel();
  assert.ok(label.length > 0);
});

test("isSafeServerUrl: https or loopback-http only", () => {
  assert.equal(isSafeServerUrl("https://api.privateer.pro"), true);
  assert.equal(isSafeServerUrl("http://localhost:5000"), true);
  assert.equal(isSafeServerUrl("http://127.0.0.1:5000"), true);
  assert.equal(isSafeServerUrl("http://evil.example"), false, "plain http to a remote host leaks the token");
  assert.equal(isSafeServerUrl("ws://x"), false);
  assert.equal(isSafeServerUrl("not a url"), false);
});

test("serverBaseUrl rejects an insecure override (would exfiltrate the bearer)", () => {
  clearCredentials();
  process.env.PRIVATEER_SERVER_URL = "https://safe.test";
  assert.equal(serverBaseUrl(), "https://safe.test");
  process.env.PRIVATEER_SERVER_URL = "http://localhost:5000";
  assert.equal(serverBaseUrl(), "http://localhost:5000", "loopback http allowed for dev");
  process.env.PRIVATEER_SERVER_URL = "http://evil.example";
  assert.throws(() => serverBaseUrl(), /https/, "remote http override is refused");
  delete process.env.PRIVATEER_SERVER_URL;
});

// authedFetch bootstraps a per-terminal child session (POST /auth/session/spawn)
// before the real request, so test mocks must answer that URL with a child pair.
const CHILD = JSON.stringify({ accessToken: "child-access", refreshToken: "child-refresh" });
function spawnAware(forOthers: () => Response): typeof fetch {
  return (async (input: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/auth/session/spawn")) {
      return new Response(CHILD, { status: 200, headers: { "content-type": "application/json" } });
    }
    return forOthers();
  }) as typeof fetch;
}

test("authedFetch spawns a per-terminal child session and auths with its token", async () => {
  saveCredentials(creds);
  const calls: { url: string; auth: string | null }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (url.includes("/auth/session/spawn")) {
      return new Response(CHILD, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const res = await authedFetch("https://example.test/whoami", {});
    assert.equal(res.status, 200);
    assert.ok(calls.some((c) => c.url.includes("/auth/session/spawn")), "minted a child session");
    const target = calls.find((c) => c.url.endsWith("/whoami"));
    // The real request carries the CHILD token, never the parent's access token.
    assert.equal(target?.auth, "Bearer child-access");
  } finally {
    globalThis.fetch = orig;
    clearCredentials();
  }
});

test("session spawn presents the parent access token + JSON body", async () => {
  saveCredentials(creds);
  let spawnAuth: string | null = null;
  let spawnCt: string | null = null;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/auth/session/spawn")) {
      const h = new Headers(init?.headers);
      spawnAuth = h.get("authorization");
      spawnCt = h.get("content-type");
      return new Response(CHILD, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    await authedFetch("https://example.test/whoami", {});
    // Possession proof: spawn carries the PARENT access token (server allows it to
    // be expired but requires a real signed token bound to the account).
    assert.equal(spawnAuth, "Bearer access-1");
    // postJson must keep Content-Type when a caller passes its own headers,
    // otherwise the server can't parse the refreshToken body (regression guard).
    assert.equal(spawnCt, "application/json");
  } finally {
    globalThis.fetch = orig;
    clearCredentials();
  }
});

test("authedFetch downgrades a hard-cap 429 to a non-retryable 402", async () => {
  saveCredentials(creds);
  const capBody = JSON.stringify({
    message: "Daily message limit of 25 reached. Upgrade or top up to continue.",
    code: "DAILY_CAP_HIT",
  });
  const orig = globalThis.fetch;
  globalThis.fetch = spawnAware(() =>
    new Response(capBody, { status: 429, headers: { "content-type": "application/json" } }));
  try {
    const res = await authedFetch("https://example.test/api/agent/v1/chat/completions", { body: "{}" });
    // 402 isn't in the SDK's retryable set, so the cap won't burn the retry budget…
    assert.equal(res.status, 402);
    // …and the body survives so describeError can still show the backend's message.
    assert.equal(await res.text(), capBody);
  } finally {
    globalThis.fetch = orig;
    clearCredentials();
  }
});

test("authedFetch leaves a transient 429 (no cap code) retryable", async () => {
  saveCredentials(creds);
  const orig = globalThis.fetch;
  globalThis.fetch = spawnAware(() =>
    new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 }));
  try {
    const res = await authedFetch("https://example.test/x", {});
    assert.equal(res.status, 429);
  } finally {
    globalThis.fetch = orig;
    clearCredentials();
  }
});

test.after(() => rmSync(home, { recursive: true, force: true }));
