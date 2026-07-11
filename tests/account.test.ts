// PRIVATEER_HOME must point somewhere disposable before the auth module resolves
// paths (globalDir reads it lazily, so setting it here is enough).
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-account-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { makeAccountProvider, privateerOAuthProvider } from "../src/providers/account.ts";
import { clearCredentials } from "../src/auth/privateer.ts";

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

test.after(() => rmSync("/private/tmp/claude-501/pv-account-test", { recursive: true, force: true }));
