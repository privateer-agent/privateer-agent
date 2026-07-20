// PRIVATEER_HOME must point somewhere disposable before the auth module resolves
// paths (globalDir reads it lazily, so setting it here is enough).
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-account-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { makeAccountProvider, privateerOAuthProvider } from "../src/providers/account.ts";
import { clearCredentials, saveCredentials } from "../src/auth/privateer.ts";

// Regression: Pi's /login builds its "Use a subscription" list from the OAuth
// providers registered via registerProvider({ oauth }). The account provider used to
// gate registration on hasCredentials(), so a fresh machine (no credentials) got NO
// Privateer option under /login — you couldn't log in because you weren't logged in.
// It must now register unconditionally so first-login works through provider auth.

test("makeAccountProvider registers the privateer OAuth provider with NO credentials", () => {
  clearCredentials();
  const calls: { name: string; config: any }[] = [];
  makeAccountProvider()({
    registerProvider: (name: string, config: unknown) => calls.push({ name, config: config as any }),
  });

  const priv = calls.find((c) => c.name === "privateer");
  assert.ok(priv, "privateer provider must be registered even when signed out");
  assert.ok(priv!.config.oauth, "registration must include the oauth login path");
  assert.equal(priv!.config.oauth.name, "Privateer account");
  assert.ok(Array.isArray(priv!.config.models) && priv!.config.models.length > 0, "must seed models");
});

test("makeAccountProvider is a no-op when the host lacks registerProvider", () => {
  clearCredentials();
  assert.doesNotThrow(() => makeAccountProvider()({}));
});

// Regression: Pi's login dialog cancels via an AbortController and passes its
// `signal` to provider.login(). login() MUST thread that signal into the device
// poll — otherwise escape/ctrl+c aborts the signal but the poll loop never sees
// it, login() never settles, and the "Waiting for authentication…" screen hangs
// with no way out. This drives a fresh (no-credentials) login with a stub server
// and asserts an abort mid-poll rejects promptly with the exact "Login cancelled"
// string Pi suppresses (no trailing period, no spurious error toast).
test("login() aborts the device poll when the dialog signal fires", async () => {
  clearCredentials();
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  const realFetch = globalThis.fetch;
  const controller = new AbortController();

  // Stub: hand out a device code, then keep saying "authorization_pending" so the
  // only way out of the poll is the abort signal.
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.endsWith("/auth/device/code")) {
      return new Response(
        JSON.stringify({ device_code: "dev", user_code: "AAAA-BBBB", expires_in: 600, interval: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "authorization_pending" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const err = await privateerOAuthProvider
      .login({ signal: controller.signal, onDeviceCode: () => controller.abort() })
      .then(() => null, (e: Error) => e);
    assert.ok(err, "login must reject when the signal is aborted, not hang");
    assert.equal(err!.message, "Login cancelled", "cancel message must match Pi's suppressed string exactly");
  } finally {
    globalThis.fetch = realFetch;
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
});

// Regression: the TUI had NO startup seed for the account credential. Pi only obtains
// one via /login, and our shutdown hook revokes the account session AND deletes its
// persisted auth.json entry — so a signed-in user who quit and relaunched landed on
// privateer/* with no key and hit "No API key found for privateer." on the first
// prompt, while the banner still read "connected". session_start must spawn a fresh
// session and store it as the provider's OAuth credential.
test("session_start seeds Pi's auth storage with a spawned account credential", async () => {
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  const realFetch = globalThis.fetch;
  saveCredentials({
    accessToken: "parent-access",
    refreshToken: "parent-refresh",
    user: { id: "u1" },
    serverBaseUrl: "https://stub.privateer.test",
  } as any);

  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.endsWith("/auth/session/spawn")) {
      return new Response(JSON.stringify({ accessToken: "child-access", refreshToken: "child-refresh" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const handlers: Record<string, (e: unknown, ctx: unknown) => void> = {};
  const stored: { provider: string; cred: any }[] = [];
  const ctx = { modelRegistry: { authStorage: { set: (p: string, c: any) => stored.push({ provider: p, cred: c }) } } };

  try {
    makeAccountProvider()({
      registerProvider: () => {},
      on: (event: string, handler: (e: unknown, ctx: unknown) => void) => { handlers[event] = handler; },
    });
    assert.ok(handlers.session_start, "provider must subscribe to session_start");
    handlers.session_start!(undefined, ctx);
    // The handler is fire-and-forget; let the spawn settle.
    for (let i = 0; i < 20 && stored.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

    assert.equal(stored.length, 1, "exactly one credential must be seeded");
    assert.equal(stored[0].provider, "privateer");
    assert.equal(stored[0].cred.type, "oauth", "Pi resolves the key through the registered oauth provider");
    assert.equal(stored[0].cred.access, "child-access");

    // A second session_start (resume/fork/reload) must NOT spawn another device row.
    handlers.session_start!(undefined, ctx);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(stored.length, 1, "seeding is once per process, not once per session_start");
  } finally {
    globalThis.fetch = realFetch;
    clearCredentials();
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
});

test.after(() => rmSync("/private/tmp/claude-501/pv-account-test", { recursive: true, force: true }));
