import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileOAuthProvider, clearStoredAuth } from "../src/mcp/oauth.ts";

const URL_A = "https://api.example.com/mcp";

// Run a body with an isolated PRIVATEER_HOME and browser launching disabled.
function withHome(fn: () => Promise<void> | void): Promise<void> {
  const prevHome = process.env.PRIVATEER_HOME;
  const prevNoBrowser = process.env.PRIVATEER_NO_BROWSER;
  const prevPort = process.env.PRIVATEER_OAUTH_PORT;
  process.env.PRIVATEER_HOME = mkdtempSync(join(tmpdir(), "priv-oauth-home-"));
  process.env.PRIVATEER_NO_BROWSER = "1";
  process.env.PRIVATEER_OAUTH_PORT = "0"; // ephemeral — avoids clashing with a real 7777
  const restore = () => {
    rmSync(process.env.PRIVATEER_HOME!, { recursive: true, force: true });
    set("PRIVATEER_HOME", prevHome);
    set("PRIVATEER_NO_BROWSER", prevNoBrowser);
    set("PRIVATEER_OAUTH_PORT", prevPort);
  };
  return Promise.resolve(fn()).finally(restore);
}
function set(k: string, v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

test("client metadata advertises a PKCE public client on the loopback redirect", () => {
  return withHome(() => {
    const p = new FileOAuthProvider("api", URL_A);
    const md = p.clientMetadata;
    assert.deepEqual(md.redirect_uris, [p.redirectUrl]);
    assert.match(String(p.redirectUrl), /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    assert.equal(md.token_endpoint_auth_method, "none");
    assert.ok(md.grant_types?.includes("refresh_token"));
  });
});

test("tokens and client info round-trip through an owner-only file", () => {
  return withHome(() => {
    const p1 = new FileOAuthProvider("api", URL_A);
    p1.saveClientInformation({ client_id: "abc", redirect_uris: [p1.redirectUrl] } as any);
    p1.saveTokens({ access_token: "secret", token_type: "Bearer" });

    // A fresh provider for the same URL reads the persisted state back.
    const p2 = new FileOAuthProvider("api", URL_A);
    assert.equal(p2.clientInformation()?.client_id, "abc");
    assert.equal(p2.tokens()?.access_token, "secret");

    // Persisted under PRIVATEER_HOME/mcp-auth as a single owner-only (0600) file.
    const dir = join(process.env.PRIVATEER_HOME!, "mcp-auth");
    const entries = readdirSync(dir);
    assert.equal(entries.length, 1);
    const mode = statSync(join(dir, entries[0])).mode & 0o777;
    if (process.platform !== "win32") assert.equal(mode, 0o600);
  });
});

test("the loopback callback resolves waitForCode with the authorization code", async () => {
  await withHome(async () => {
    const p = new FileOAuthProvider("api", URL_A);
    const state = p.state(); // arm CSRF state
    const waiting = p.waitForCode(5_000);
    // redirectToAuthorization binds the loopback server and (would) open the browser.
    await p.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));

    // Simulate the browser being redirected back with the code.
    const res = await fetch(`${p.redirectUrl}?code=the-code&state=${state}`);
    assert.equal(res.status, 200);
    assert.equal(await waiting, "the-code");
  });
});

test("a mismatched state rejects (CSRF guard)", async () => {
  await withHome(async () => {
    const p = new FileOAuthProvider("api", URL_A);
    p.state();
    // Attach the rejection expectation before triggering, so the reject isn't
    // momentarily unhandled (which node:test would flag as a failure).
    const expectation = assert.rejects(() => p.waitForCode(5_000), /state mismatch/);
    await p.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
    await fetch(`${p.redirectUrl}?code=x&state=WRONG`);
    await expectation;
  });
});

test("clearStoredAuth removes the persisted file", () => {
  return withHome(() => {
    const p = new FileOAuthProvider("api", URL_A);
    p.saveTokens({ access_token: "t", token_type: "Bearer" });
    const dir = join(process.env.PRIVATEER_HOME!, "mcp-auth");
    assert.equal(readdirSync(dir).length, 1);
    clearStoredAuth(URL_A);
    assert.equal(readdirSync(dir).length, 0);
  });
});
