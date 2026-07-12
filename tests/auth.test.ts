// PRIVATEER_HOME must point somewhere disposable before the auth module resolves
// paths (globalDir reads it lazily, so setting it here is enough).
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-auth-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  isSafeServerUrl,
  serverBaseUrl,
  DEFAULT_SERVER_URL,
  saveCredentials,
  loadCredentials,
  hasCredentials,
  currentUser,
  clearCredentials,
  defaultDeviceLabel,
  spawnAccountCredentials,
  warmSession,
  revokeLocalSessions,
  revokeAccountSession,
  type Credentials,
} from "../src/auth/privateer.ts";

// Offline-testable surface: URL safety, base-URL resolution, credential storage.
// The network flows (device login / spawn / refresh) need the account server and
// are covered by a live login smoke gated on real credentials.

test("isSafeServerUrl: https ok, http only for loopback", () => {
  assert.equal(isSafeServerUrl("https://helix-server.example.com"), true);
  assert.equal(isSafeServerUrl("http://localhost:8080"), true);
  assert.equal(isSafeServerUrl("http://127.0.0.1:3000"), true);
  assert.equal(isSafeServerUrl("http://evil.example.com"), false); // plaintext to remote → token exfil risk
  assert.equal(isSafeServerUrl("ftp://x"), false);
  assert.equal(isSafeServerUrl("not a url"), false);
});

test("serverBaseUrl: env override wins but must be safe", () => {
  const saved = process.env.PRIVATEER_SERVER_URL;
  try {
    process.env.PRIVATEER_SERVER_URL = "https://dev.example.com/";
    assert.equal(serverBaseUrl(), "https://dev.example.com"); // trailing slash trimmed
    process.env.PRIVATEER_SERVER_URL = "http://evil.example.com";
    assert.throws(() => serverBaseUrl(), /Refusing PRIVATEER_SERVER_URL/);
  } finally {
    if (saved === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = saved;
  }
});

test("serverBaseUrl: defaults to the built-in host with no env / no creds", () => {
  const saved = process.env.PRIVATEER_SERVER_URL;
  delete process.env.PRIVATEER_SERVER_URL;
  clearCredentials();
  try {
    assert.equal(serverBaseUrl(), DEFAULT_SERVER_URL);
  } finally {
    if (saved !== undefined) process.env.PRIVATEER_SERVER_URL = saved;
  }
});

test("credentials: save → load → clear roundtrip", () => {
  clearCredentials();
  assert.equal(hasCredentials(), false);
  const creds: Credentials = {
    accessToken: "at",
    refreshToken: "rt",
    user: { id: "u1", email: "a@b.co", solanaPublicKey: null, kekSource: null },
    serverBaseUrl: "https://helix-server.example.com",
  };
  saveCredentials(creds);
  assert.equal(hasCredentials(), true);
  assert.deepEqual(loadCredentials(), creds);
  assert.equal(currentUser()?.id, "u1");
  clearCredentials();
  assert.equal(loadCredentials(), null);
  assert.equal(currentUser(), null);
});

test("defaultDeviceLabel is a non-empty string", () => {
  assert.ok(defaultDeviceLabel().length > 0);
});

// Exit-time cleanup: on quit, revokeLocalSessions revokes BOTH server-side sessions this
// terminal created — the in-memory CHILD session (authedFetch) AND the account-provider
// inference session — so the terminal fully drops off the app's Linked Devices list the
// instant it closes, instead of lingering ~24h until its token TTL. Revoking the account
// session on quit is safe ONLY because the caller (cli/chat.ts) also drops Pi's persisted
// copy via authStorage.remove("privateer") so the next launch spawns fresh rather than
// reusing the revoked token — that removal is on the caller, not this function, so it's not
// exercised here. We stub global fetch to record calls without hitting the network; each
// spawn mints a fresh, distinguishable token so we can assert WHICH sessions get revoked.
test("revokeLocalSessions revokes both the child and the account session on quit", async () => {
  const savedFetch = globalThis.fetch;
  const savedEnv = process.env.PRIVATEER_SERVER_URL;
  const calls: { url: string; method?: string; auth?: string }[] = [];
  let spawnN = 0;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    calls.push({ url, method, auth: headers.get("Authorization") ?? undefined });
    if (url.endsWith("/auth/session/spawn")) {
      spawnN += 1;
      return new Response(JSON.stringify({ accessToken: `access-${spawnN}`, refreshToken: `refresh-${spawnN}` }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    process.env.PRIVATEER_SERVER_URL = "https://acct.example.com";
    saveCredentials({
      accessToken: "parent-at",
      refreshToken: "parent-rt",
      user: { id: "u1", email: "a@b.co", solanaPublicKey: null, kekSource: null },
      serverBaseUrl: "https://acct.example.com",
    });

    await spawnAccountCredentials(); // Pi's account channel → access-1
    await warmSession(); // this terminal's in-memory child session → access-2
    calls.length = 0; // only care about what revoke does

    await revokeLocalSessions();
    const deletes = calls.filter((c) => c.method === "DELETE");
    assert.equal(deletes.length, 2, "both sessions DELETE'd on quit");
    assert.ok(deletes.every((d) => d.url.endsWith("/auth/session/current")));
    const revokedTokens = deletes.map((d) => d.auth).sort();
    assert.deepEqual(revokedTokens, ["Bearer access-1", "Bearer access-2"],
      "revokes BOTH the account (access-1) and the child (access-2) session on quit");

    // Both revokes are idempotent — a second quit-revoke (or a redundant explicit
    // sign-out) is a no-op since the in-memory handles were cleared.
    calls.length = 0;
    await revokeLocalSessions();
    await revokeAccountSession();
    assert.equal(calls.length, 0, "second quit-revoke + sign-out are no-ops (sessions already gone)");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedEnv === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = savedEnv;
    clearCredentials();
  }
});

test.after(() => rmSync("/private/tmp/claude-501/pv-auth-test", { recursive: true, force: true }));
