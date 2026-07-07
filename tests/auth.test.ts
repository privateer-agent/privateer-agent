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

test.after(() => rmSync("/private/tmp/claude-501/pv-auth-test", { recursive: true, force: true }));
