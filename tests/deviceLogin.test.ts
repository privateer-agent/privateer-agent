// PRIVATEER_HOME must point somewhere disposable before the auth module resolves
// paths (globalDir reads it lazily, so setting it here is enough).
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-device-login-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  requestDeviceCode,
  pollForToken,
  runDeviceLogin,
  loadCredentials,
  clearCredentials,
  onSignedIn,
  type DeviceCode,
} from "../src/auth/privateer.ts";
import { loadAccountSignKey, clearAccountSignKey } from "../src/crypto/accountTrust.ts";

// The device authorization grant (RFC 8628) is how EVERY terminal signs in — CLI,
// harbor and the desktop app all funnel through requestDeviceCode + pollForToken.
// Until now none of it was tested: auth.test.ts covers storage and revocation and
// says outright that "the network flows need the account server". They do — but the
// PROTOCOL half doesn't, and that half is where the failure modes live:
//
//   • a poll response is an HTTP 400 whose BODY carries the real state, so treating
//     "not ok" as failure would abort a login the instant the user hadn't clicked yet;
//   • `slow_down` must actually slow the polling down, or the server starts refusing;
//   • denial and expiry must be told apart, because only one of them is worth retrying;
//   • the credential must be written and the account's signing key pinned in the SAME
//     step, since a login that lands without a pin leaves channel-config verification
//     fail-closed until the next re-link.
//
// A stub server pinned here costs nothing and runs offline. The live counterpart —
// a real code approved against the real server — is
// `treeview/desktop/scripts/check-account-drive.mjs`, gated on smoke credentials.

const BASE = "https://acct.example.com";

/** Install a fetch stub that answers the two device endpoints from a script. */
function stubServer(handler: (path: string, body: any) => Response | Promise<Response>) {
  const saved = { fetch: globalThis.fetch, env: process.env.PRIVATEER_SERVER_URL };
  const calls: { path: string; body: any }[] = [];
  process.env.PRIVATEER_SERVER_URL = BASE;
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const path = String(input).slice(BASE.length);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    return handler(path, body);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = saved.fetch;
      if (saved.env === undefined) delete process.env.PRIVATEER_SERVER_URL;
      else process.env.PRIVATEER_SERVER_URL = saved.env;
      clearCredentials();
      clearAccountSignKey();
    },
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const CODE: DeviceCode = {
  device_code: "dc-1",
  user_code: "WXYZ-2345",
  verification_uri: `${BASE}/settings/link-terminal`,
  verification_uri_complete: `${BASE}/settings/link-terminal?code=WXYZ-2345`,
  expires_in: 600,
  interval: 1, // the flow floors this at 1s; keep the tests honest but quick
};

const GRANT = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  user: { id: "u1", email: "smoke@example.com", solanaPublicKey: null, kekSource: null },
  accountSignPub: "YWNjb3VudC1zaWduLXB1Yg==",
};

// The fresh-home test runs FIRST on purpose: the keypair is memoized for the
// process lifetime, so only the first call in this file can observe the mint.

test("a first-ever login on a machine with no privateer home still carries the pubkey", async () => {
  // Regression: the keypair is minted on first use, and requestDeviceCode SWALLOWS a
  // throw from that mint (a login must not fail over a key it can live without). So a
  // home directory that didn't exist yet — the state a fresh machine is in when its
  // very first action is /login — produced a login that silently shipped no pubkey.
  // Nothing downstream reports that: the app just has nothing to pin, and every
  // app-sealed secret to this terminal is impossible until the machine is re-linked.
  const savedHome = process.env.PRIVATEER_HOME!;
  const fresh = join(savedHome, "never-created", "privateer");
  process.env.PRIVATEER_HOME = fresh;
  const server = stubServer(() => json(CODE));
  try {
    await requestDeviceCode("fresh-machine");
    assert.equal(typeof server.calls[0].body.terminalPub, "string");
    assert.ok(existsSync(join(fresh, "terminal-key.json")), "the key was not persisted");
    assert.equal(statSync(fresh).mode & 0o777, 0o700, "the home holds a private key — owner-only");
  } finally {
    server.restore();
    rmSync(fresh, { recursive: true, force: true });
    process.env.PRIVATEER_HOME = savedHome;
  }
});

test("requestDeviceCode asks for a code and carries this terminal's public key", async () => {
  const server = stubServer(() => json(CODE));
  try {
    const code = await requestDeviceCode("my-laptop");
    assert.equal(code.user_code, "WXYZ-2345");
    assert.equal(server.calls[0].path, "/auth/device/code");
    assert.equal(server.calls[0].body.deviceLabel, "my-laptop");
    // The pubkey rides the grant so the app can pin it on approval (TOFU) — that pin
    // is what later lets the app seal a channel token only this machine can open.
    assert.equal(typeof server.calls[0].body.terminalPub, "string");
    assert.ok(server.calls[0].body.terminalPub.length > 0);
  } finally {
    server.restore();
  }
});

test("requestDeviceCode reports a server that won't start a login", async () => {
  const server = stubServer(() => json({ message: "nope" }, 503));
  try {
    await assert.rejects(requestDeviceCode("x"), /Couldn't start login \(503\)/);
  } finally {
    server.restore();
  }
});

test("pollForToken waits through authorization_pending, then saves and pins the grant", async () => {
  let polls = 0;
  const server = stubServer((path) => {
    assert.equal(path, "/auth/device/token");
    polls += 1;
    // The un-approved state is an HTTP 400 whose BODY carries the real answer.
    // Reading only the status here would abort the login before the user clicked.
    return polls === 1 ? json({ error: "authorization_pending" }, 400) : json(GRANT);
  });
  const states: string[] = [];
  let signedIn = 0;
  const off = onSignedIn(() => { signedIn += 1; });
  try {
    const creds = await pollForToken(CODE, { onPoll: (s) => states.push(s) });
    assert.equal(polls, 2);
    assert.deepEqual(states, ["pending"]);
    assert.equal(creds.user.email, "smoke@example.com");
    assert.equal(creds.serverBaseUrl, BASE, "the credential records the server it was minted by");

    // Written, not just returned: the next process must find this login on disk.
    assert.equal(loadCredentials()?.accessToken, "at-1");
    // Pinned in the same step (F7/F8) — a login without a pin leaves app→terminal
    // channel config unverifiable until the machine is linked again.
    assert.equal(loadAccountSignKey(), GRANT.accountSignPub);
    assert.equal(signedIn, 1, "a completed login announces itself to the UI");
  } finally {
    off();
    server.restore();
  }
});

test("slow_down actually slows the polling down", async () => {
  // RFC 8628: back off on slow_down or the server starts rejecting the polls. The
  // 5s default is floored to CODE.interval (1s) here, so a compliant client's second
  // gap is 1s + 2s = 3s and a non-compliant one's is still 1s.
  const at: number[] = [];
  let polls = 0;
  const server = stubServer(() => {
    at.push(Date.now());
    polls += 1;
    return polls === 1 ? json({ error: "slow_down" }, 400) : json(GRANT);
  });
  const states: string[] = [];
  try {
    await pollForToken(CODE, { onPoll: (s) => states.push(s) });
    assert.deepEqual(states, ["slow_down"]);
    const gap = at[1] - at[0];
    assert.ok(gap >= 2500, `second poll came ${gap}ms after the first — the back-off was ignored`);
  } finally {
    server.restore();
  }
});

test("a denial and an expiry are different errors, and neither writes a credential", async () => {
  for (const [error, pattern] of [
    ["access_denied", /denied in the app/i],
    ["expired_token", /expired/i],
  ] as const) {
    const server = stubServer(() => json({ error }, 400));
    try {
      await assert.rejects(pollForToken(CODE), pattern);
      assert.equal(loadCredentials(), null, `${error} must not leave a credential behind`);
    } finally {
      server.restore();
    }
  }
});

test("an unrecognised poll failure surfaces the status rather than looping forever", async () => {
  const server = stubServer(() => json({ error: "server_error" }, 500));
  try {
    await assert.rejects(pollForToken(CODE), /Login failed \(500: server_error\)/);
  } finally {
    server.restore();
  }
});

test("cancelling the wait stops the login", async () => {
  const server = stubServer(() => json({ error: "authorization_pending" }, 400));
  const ac = new AbortController();
  try {
    const pending = pollForToken(CODE, { signal: ac.signal });
    ac.abort();
    await assert.rejects(pending, /cancelled/i);
    assert.equal(loadCredentials(), null);
  } finally {
    server.restore();
  }
});

test("a code that runs out of time stops polling and says so", async () => {
  // The poll loop is bounded by the code's own lifetime, not by the server's answers:
  // a UI left open past the window must report the expiry rather than poll a dead code
  // until the process ends. expires_in: 1 gives room for exactly one poll.
  const server = stubServer(() => json({ error: "authorization_pending" }, 400));
  try {
    await assert.rejects(pollForToken({ ...CODE, expires_in: 1 }), /expired/i);
    assert.ok(server.calls.length <= 1, `polled ${server.calls.length}× past the deadline`);
    assert.equal(loadCredentials(), null);
  } finally {
    server.restore();
  }
});

test("runDeviceLogin hands the code to the UI before it starts waiting", async () => {
  // The whole flow is unusable if the code is surfaced late: the user has ~10 minutes
  // and cannot approve what they haven't been shown. Assert the ordering, not just
  // that onCode fired.
  const order: string[] = [];
  let polls = 0;
  const server = stubServer((path) => {
    if (path === "/auth/device/code") { order.push("code"); return json(CODE); }
    order.push("poll");
    polls += 1;
    return polls === 1 ? json({ error: "authorization_pending" }, 400) : json(GRANT);
  });
  try {
    const user = await runDeviceLogin({ onCode: () => order.push("shown") });
    assert.equal(user.email, "smoke@example.com");
    assert.deepEqual(order, ["code", "shown", "poll", "poll"]);
  } finally {
    server.restore();
    rmSync(process.env.PRIVATEER_HOME!, { recursive: true, force: true });
  }
});
