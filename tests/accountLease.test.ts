/**
 * Concurrent harbor runs share ONE account session, and only the last one out revokes it.
 *
 * The bug this pins: each run minted its own session into a single per-process slot,
 * then revoked "the" session when it finished — so run A finishing revoked run B's
 * session mid-turn, and A's own leaked server-side until its TTL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccountLease } from "../src/harbor/accountLease.ts";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function counting() {
  const events: string[] = [];
  let n = 0;
  return {
    events,
    deps: {
      mint: async () => {
        events.push(`mint${++n}`);
      },
      revoke: async () => {
        events.push(`revoke${n}`);
      },
    },
  };
}

test("account lease: overlapping runs mint once and revoke once, after the last release", async () => {
  const { events, deps } = counting();
  const lease = createAccountLease(deps);
  assert.equal(await lease.acquire(), true); // run A
  assert.equal(await lease.acquire(), true); // run B, overlapping
  await lease.release(); // A finishes first
  assert.deepEqual(events, ["mint1"], "A finishing must not revoke the session B is using");
  await lease.release(); // B finishes
  assert.deepEqual(events, ["mint1", "revoke1"]);
  assert.equal(lease.refs, 0);
});

test("account lease: a run starting after the last release gets a fresh session", async () => {
  const { events, deps } = counting();
  const lease = createAccountLease(deps);
  await lease.acquire();
  await lease.release();
  await lease.acquire();
  await lease.release();
  assert.deepEqual(events, ["mint1", "revoke1", "mint2", "revoke2"]);
});

test("account lease: concurrent first acquires share one mint", async () => {
  const gate = deferred();
  let mints = 0;
  const lease = createAccountLease({
    mint: async () => {
      mints++;
      await gate.promise;
    },
    revoke: async () => {},
  });
  const a = lease.acquire();
  const b = lease.acquire();
  gate.resolve();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(mints, 1);
});

test("account lease: a new run waits out the previous session's revoke before minting", async () => {
  const revoking = deferred();
  const events: string[] = [];
  const lease = createAccountLease({
    mint: async () => {
      events.push("mint");
    },
    revoke: async () => {
      events.push("revoke:start");
      await revoking.promise;
      events.push("revoke:end");
    },
  });
  await lease.acquire();
  const released = lease.release(); // last out — revoke in flight
  const next = lease.acquire(); // a new run arrives mid-revoke
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ["mint", "revoke:start"], "no mint while the old session is still being dropped");
  revoking.resolve();
  await released;
  assert.equal(await next, true);
  assert.deepEqual(events, ["mint", "revoke:start", "revoke:end", "mint"]);
});

test("account lease: a failed mint is reported, not cached, and never revoked", async () => {
  let attempt = 0;
  let revokes = 0;
  const logs: string[] = [];
  const lease = createAccountLease({
    mint: async () => {
      if (++attempt === 1) throw new Error("offline");
    },
    revoke: async () => {
      revokes++;
    },
    log: (m) => logs.push(m),
  });
  assert.equal(await lease.acquire(), false);
  assert.match(logs[0], /offline/);
  assert.equal(await lease.acquire(), true, "the next run retries instead of inheriting the failure");
  await lease.release();
  await lease.release();
  assert.equal(revokes, 1, "only the session that was actually minted is revoked");
  assert.equal(lease.refs, 0);
});

test("account lease: an unpaired release is a no-op", async () => {
  const { events, deps } = counting();
  const lease = createAccountLease(deps);
  await lease.release();
  assert.equal(lease.refs, 0);
  assert.deepEqual(events, []);
});
