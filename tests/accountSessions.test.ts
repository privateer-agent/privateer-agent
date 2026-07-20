// PRIVATEER_HOME must point somewhere disposable before the auth module resolves
// paths (globalDir reads it lazily, so setting it here is enough).
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-account-sessions-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import {
  recordOwnedSession,
  forgetOwnedSession,
  orphanedSessions,
  dropOwnedSession,
  clearOwnedSessions,
} from "../src/auth/accountSessions.ts";
import { acquireAccountCredential, saveCredentials, clearCredentials } from "../src/auth/privateer.ts";
import { accountSessionsPath } from "../src/config/paths.ts";

// A pid that cannot be running: above every platform's pid_max, so signal 0 is
// guaranteed to report ESRCH rather than accidentally naming a real process.
const DEAD_PID = 4_194_305;

function seedRegistry(entries: Record<string, { refresh: string; expires: number }>): void {
  mkdirSync(process.env.PRIVATEER_HOME!, { recursive: true });
  writeFileSync(accountSessionsPath(), JSON.stringify(entries, null, 2));
}

function readRegistry(): Record<string, { refresh: string; expires: number }> {
  return JSON.parse(readFileSync(accountSessionsPath(), "utf8"));
}

test("recordOwnedSession claims the session for this pid; forget drops it", () => {
  clearOwnedSessions();
  recordOwnedSession({ refresh: "r1", expires: Date.now() + 60_000 });

  const reg = readRegistry();
  assert.deepEqual(Object.keys(reg), [String(process.pid)], "the entry is keyed by the owning pid");
  assert.equal(reg[String(process.pid)].refresh, "r1");
  // Holds refresh tokens — must never be world-readable.
  assert.equal(statSync(accountSessionsPath()).mode & 0o077, 0, "registry must be 0600");

  forgetOwnedSession();
  assert.deepEqual(readRegistry(), {});
});

// The core safety property. A session belonging to a terminal that is STILL RUNNING
// must never be offered up for reclamation: adopting it rotates the refresh token out
// from under that terminal and kills a working session.
test("orphanedSessions ignores sessions owned by a live process", () => {
  clearOwnedSessions();
  const future = Date.now() + 60_000;
  seedRegistry({
    [String(process.pid)]: { refresh: "mine", expires: future },
    [String(DEAD_PID)]: { refresh: "orphan", expires: future },
  });

  const orphans = orphanedSessions();
  assert.equal(orphans.length, 1, "only the dead owner's session is reclaimable");
  assert.equal(orphans[0].refresh, "orphan");
  assert.equal(orphans[0].pid, DEAD_PID);
});

test("orphanedSessions prunes expired and malformed entries", () => {
  clearOwnedSessions();
  const now = Date.now();
  seedRegistry({
    [String(DEAD_PID)]: { refresh: "stale", expires: now - 1 }, // dead server-side anyway
    [String(DEAD_PID + 1)]: { refresh: "", expires: now + 60_000 }, // no token to reclaim with
    [String(DEAD_PID + 2)]: { refresh: "live", expires: now + 60_000 },
  });

  const orphans = orphanedSessions(now);
  assert.deepEqual(
    orphans.map((o) => o.refresh),
    ["live"],
  );
  assert.deepEqual(Object.keys(readRegistry()), [String(DEAD_PID + 2)], "unusable entries are pruned from disk");
});

test("dropOwnedSession removes one entry and leaves the rest", () => {
  clearOwnedSessions();
  const future = Date.now() + 60_000;
  seedRegistry({
    [String(DEAD_PID)]: { refresh: "a", expires: future },
    [String(DEAD_PID + 1)]: { refresh: "b", expires: future },
  });

  dropOwnedSession(DEAD_PID);
  assert.deepEqual(Object.keys(readRegistry()), [String(DEAD_PID + 1)]);
});

// Regression: every launch used to spawn a brand-new server-side session, so a
// terminal killed without its shutdown hook leaked a row for its full ~24h TTL. Enough
// of those and /auth/session/spawn is refused with 429 CHILD_SESSION_CAP, taking the
// account channel down. A launch must reclaim an orphan rather than stack another row.
test("acquireAccountCredential adopts an orphaned session instead of spawning", async () => {
  clearOwnedSessions();
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  const realFetch = globalThis.fetch;
  saveCredentials({
    accessToken: "parent-access",
    refreshToken: "parent-refresh",
    user: { id: "u1" },
    serverBaseUrl: "https://stub.privateer.test",
  } as any);
  seedRegistry({ [String(DEAD_PID)]: { refresh: "orphan-refresh", expires: Date.now() + 60_000 } });

  const calls: string[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    calls.push(url.replace("https://stub.privateer.test", ""));
    if (url.endsWith("/auth/refresh")) {
      assert.equal(JSON.parse(init.body).refreshToken, "orphan-refresh", "must rotate the ORPHAN's token");
      return new Response(JSON.stringify({ accessToken: "adopted-access", refreshToken: "adopted-refresh" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ accessToken: "spawned", refreshToken: "spawned-r" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const cred = await acquireAccountCredential();
    assert.equal(cred.access, "adopted-access", "the orphan's session is reused");
    assert.ok(!calls.includes("/auth/session/spawn"), "no new session row may be created");
    const reg = readRegistry();
    assert.deepEqual(Object.keys(reg), [String(process.pid)], "ownership transfers to this terminal");
    assert.equal(reg[String(process.pid)].refresh, "adopted-refresh");
  } finally {
    globalThis.fetch = realFetch;
    clearCredentials();
    clearOwnedSessions();
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
});

// An orphan the server has already forgotten must not dead-end the launch: the refusal
// is proof the row is gone, so it is dropped and we fall through to a fresh spawn.
test("acquireAccountCredential falls back to a spawn when the orphan is dead", async () => {
  clearOwnedSessions();
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  const realFetch = globalThis.fetch;
  saveCredentials({
    accessToken: "parent-access",
    refreshToken: "parent-refresh",
    user: { id: "u1" },
    serverBaseUrl: "https://stub.privateer.test",
  } as any);
  seedRegistry({ [String(DEAD_PID)]: { refresh: "dead-refresh", expires: Date.now() + 60_000 } });

  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.endsWith("/auth/refresh")) {
      return new Response(JSON.stringify({ code: "SESSION_REVOKED" }), { status: 401 });
    }
    return new Response(JSON.stringify({ accessToken: "spawned-access", refreshToken: "spawned-refresh" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const cred = await acquireAccountCredential();
    assert.equal(cred.access, "spawned-access", "a fresh session is spawned when nothing can be reclaimed");
    const reg = readRegistry();
    assert.deepEqual(Object.keys(reg), [String(process.pid)], "the dead orphan is forgotten, ours recorded");
  } finally {
    globalThis.fetch = realFetch;
    clearCredentials();
    clearOwnedSessions();
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
});

// A refresh that never reached the server proves nothing. Dropping the entry there
// would strand a row that is very likely still alive, so it must survive to be
// retried on the next launch.
test("acquireAccountCredential keeps an orphan whose refresh was unreachable", async () => {
  clearOwnedSessions();
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  const realFetch = globalThis.fetch;
  saveCredentials({
    accessToken: "parent-access",
    refreshToken: "parent-refresh",
    user: { id: "u1" },
    serverBaseUrl: "https://stub.privateer.test",
  } as any);
  seedRegistry({ [String(DEAD_PID)]: { refresh: "unreachable", expires: Date.now() + 60_000 } });

  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.endsWith("/auth/refresh")) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ accessToken: "spawned-access", refreshToken: "spawned-refresh" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const cred = await acquireAccountCredential();
    assert.equal(cred.access, "spawned-access");
    assert.ok(
      String(DEAD_PID) in readRegistry(),
      "an orphan we merely failed to REACH must stay reclaimable",
    );
  } finally {
    globalThis.fetch = realFetch;
    clearCredentials();
    clearOwnedSessions();
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
});

// Reclaiming one orphan still leaves the others occupying session slots on the server
// — which is what puts a device at the cap in the first place. Their terminals are
// gone, so the rows are pure waste: revoke them.
test("acquireAccountCredential revokes the orphans it did not adopt", async () => {
  clearOwnedSessions();
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  const realFetch = globalThis.fetch;
  saveCredentials({
    accessToken: "parent-access",
    refreshToken: "parent-refresh",
    user: { id: "u1" },
    serverBaseUrl: "https://stub.privateer.test",
  } as any);
  const future = Date.now() + 60_000;
  seedRegistry({
    [String(DEAD_PID)]: { refresh: "first", expires: future },
    [String(DEAD_PID + 1)]: { refresh: "second", expires: future },
  });

  const revoked: string[] = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    if (url.endsWith("/auth/session/current") && init?.method === "DELETE") {
      revoked.push(String(init.headers.Authorization));
      return new Response("", { status: 204 });
    }
    if (url.endsWith("/auth/refresh")) {
      const sent = JSON.parse(init.body).refreshToken;
      return new Response(JSON.stringify({ accessToken: `${sent}-access`, refreshToken: `${sent}-r2` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ accessToken: "spawned", refreshToken: "spawned-r" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const cred = await acquireAccountCredential();
    assert.equal(cred.access, "first-access", "the first reclaimable orphan is adopted");
    // Cleanup is detached so it can't delay startup; give it a moment to land.
    for (let i = 0; i < 50 && revoked.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(revoked, ["Bearer second-access"], "the unadopted orphan's row is freed");
    const reg = readRegistry();
    assert.deepEqual(Object.keys(reg), [String(process.pid)], "only this terminal's session remains tracked");
    assert.equal(reg[String(process.pid)].refresh, "first-r2", "revoking others must not clobber our own entry");
  } finally {
    globalThis.fetch = realFetch;
    clearCredentials();
    clearOwnedSessions();
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
});

test.after(() => rmSync("/private/tmp/claude-501/pv-account-sessions-test", { recursive: true, force: true }));
