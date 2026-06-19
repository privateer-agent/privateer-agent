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
  DEFAULT_SERVER_URL,
  defaultDeviceLabel,
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

test.after(() => rmSync(home, { recursive: true, force: true }));
