/**
 * A harbor that came up signed out must join the relay by itself once an account
 * signs in on the machine — without being restarted.
 *
 * This is the "Connecting…, forever" bug. syncRelay() bails when there are no
 * credentials, and start() was effectively its only caller: the three IPC commands
 * that also call it (add / resume / reload) are ones the desktop app never sends,
 * and its 5s status poll sends only `status`. So a harbor started before the user
 * signed in — a login-service harbor at boot, one whose credentials had lapsed —
 * kept answering IPC (the app called it *running*) with a relay socket it had never
 * opened. Signing in wrote credentials.json and changed nothing. No routine fired,
 * no spawn was answered, and the app's only word for it was "Connecting".
 *
 * The fix is one line in tick(), so the test is the scheduler's own heartbeat: run a
 * tick across a sign-in and assert the harbor stopped reporting itself as signed out.
 * The relay does NOT connect here (the credential points at a dead loopback port) —
 * "it tried" is the whole claim, and it's the one that was false.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harbor } from "../src/harbor/index.ts";
import { sendToHarbor, harborSocketPath } from "../src/harbor/ipc.ts";
import { clearCredentials } from "../src/auth/privateer.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSocket(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (existsSync(harborSocketPath())) return;
    await sleep(25);
  }
  throw new Error("harbor socket never appeared");
}

test("harbor relay: a harbor started signed out joins the relay once credentials appear", async () => {
  const home = mkdtempSync(join(tmpdir(), "priv-relay-retry-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  const harbor = new Harbor();
  try {
    await harbor.start();
    await waitForSocket();

    const before = await sendToHarbor({ cmd: "status" });
    assert.equal(before.relay?.connected, false);
    assert.equal(before.relay?.reason, "signed-out", "nothing is signed in in this temp home");

    // Sign in the way another process does: credentials.json simply appears in
    // PRIVATEER_HOME. The harbor is already up and is never told about it.
    // 127.0.0.1:1 is a safe server URL (loopback) that nothing is listening on, so
    // the relay's ticket mint fails locally instead of reaching a real server.
    writeFileSync(
      join(home, "credentials.json"),
      JSON.stringify({
        accessToken: "test-access",
        refreshToken: "test-refresh",
        user: { id: "u-1", email: "harbor@example.test" },
        serverBaseUrl: "http://127.0.0.1:1",
      }),
    );

    const internals = harbor as unknown as { tick(): Promise<void>; relay?: unknown };
    assert.equal(internals.relay, undefined, "no relay client yet — start() found no credential");

    // One beat of the scheduler — the same call the 60s interval makes.
    await internals.tick();

    // The claim is that a client now EXISTS. Asserting on the reported reason alone
    // would not catch the regression: relayStatus() re-reads hasCredentials() on
    // every call, so an unfixed harbor — which never builds a client — also stops
    // saying "signed-out" the moment the file lands, while remaining just as dead.
    assert.notEqual(internals.relay, undefined, "the harbor re-read the credential and started a relay client");

    const after = await sendToHarbor({ cmd: "status" });
    assert.equal(after.relay?.connected, false, "and honestly reports it isn't up yet");
    assert.equal(after.relay?.reason, "connecting", "as trying, not as signed out");
  } finally {
    harbor.stop();
    // The credential cache is process-global (a registered symbol), so a test that
    // signs in has to sign out again or it leaks into whatever runs next.
    clearCredentials();
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
