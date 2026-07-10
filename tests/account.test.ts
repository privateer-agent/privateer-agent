// PRIVATEER_HOME must point somewhere disposable before the auth module resolves
// paths (globalDir reads it lazily, so setting it here is enough).
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-account-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { makeAccountProvider } from "../src/providers/account.ts";
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

test.after(() => rmSync("/private/tmp/claude-501/pv-account-test", { recursive: true, force: true }));
