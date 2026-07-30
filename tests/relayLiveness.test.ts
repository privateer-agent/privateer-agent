/**
 * The relay socket's liveness watchdog.
 *
 * A websocket can die without closing — a server instance restarts, a NAT drops the
 * flow, a laptop sleeps — and the kernel keeps reporting ESTABLISHED. RelayClient
 * only reconnects on 'close', so before the watchdog that state was permanent AND
 * silent: the harbor logged "connected" while the server dropped it from its presence
 * registry after ~60s, so the app showed the Harbor as inactive indefinitely.
 *
 * These tests drive the watchdog on a fake socket with mocked timers, so they assert
 * the behavior that matters (ping while healthy, terminate once the peer goes quiet)
 * without a real relay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "priv-relay-live-"));
process.env.PRIVATEER_HOME = HOME;

const { RelayClient } = await import("../src/remote/relayClient.ts");
const { describeRelay, formatDuration } = await import("../src/harbor/ipc.ts");

test.after(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

// Minimal stand-in for a `ws` socket: only what the watchdog touches.
function fakeSocket() {
  return {
    readyState: 1, // WebSocket.OPEN
    pings: 0,
    terminated: false,
    ping() { this.pings += 1; },
    terminate() { this.terminated = true; },
  };
}

/** Attach the watchdog to `ws` as if it had just opened. */
function watch(relay: any, ws: unknown) {
  relay.ws = ws;
  relay.startHeartbeat(ws);
}

test("relay watchdog: pings a healthy socket and leaves it alone", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_700_000_000_000 });
  const status: string[] = [];
  const relay: any = new RelayClient({ onStatus: (s: string) => status.push(s) } as any, { termId: "routines-t", label: "t" });
  const ws = fakeSocket();
  watch(relay, ws);

  // Two heartbeat intervals with the peer answering (any inbound frame counts).
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(20_000);
    relay.lastInboundAt = Date.now(); // the pong / server ping we'd have received
  }

  assert.equal(ws.pings, 2, "pings on each heartbeat tick");
  assert.equal(ws.terminated, false, "a socket that keeps answering is never dropped");
  assert.deepEqual(status, [], "and nothing is reported to the user");
  relay.stop();
});

test("relay watchdog: terminates a socket the server has gone silent on", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_700_000_000_000 });
  const status: string[] = [];
  const relay: any = new RelayClient({ onStatus: (s: string) => status.push(s) } as any, { termId: "routines-t", label: "t" });
  const ws = fakeSocket();
  watch(relay, ws);

  // Nothing inbound, ever — the half-open case. The threshold is 75s (three missed
  // 25s server pings), so it survives the first three ticks and dies on the fourth.
  t.mock.timers.tick(20_000);
  t.mock.timers.tick(20_000);
  t.mock.timers.tick(20_000);
  assert.equal(ws.terminated, false, "one or two missed pings are not yet a dead socket");
  t.mock.timers.tick(20_000);

  assert.equal(ws.terminated, true, "80s of silence drops the socket so the reconnect path runs");
  assert.match(status.join("\n"), /went silent/i, "and says so — this used to fail invisibly");
  relay.stop();
});

test("relay watchdog: stops policing a socket that has been replaced or stopped", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_700_000_000_000 });
  const relay: any = new RelayClient({} as any, { termId: "routines-t", label: "t" });
  const old = fakeSocket();
  watch(relay, old);

  // A reconnect swapped in a new socket; the old timer must not terminate it (or
  // anything else) on the next tick.
  const fresh = fakeSocket();
  relay.ws = fresh;
  t.mock.timers.tick(20_000);
  assert.equal(old.pings, 0, "the stale watchdog stops touching the socket it no longer owns");
  assert.equal(fresh.pings, 0, "and does not adopt the new one");

  // stop() must clear the timer outright.
  watch(relay, fresh);
  relay.stop();
  t.mock.timers.tick(200_000);
  assert.equal(fresh.terminated, false, "no watchdog runs after stop()");
});

test("relay watchdog: a closing socket is left for the close handler", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_700_000_000_000 });
  const relay: any = new RelayClient({} as any, { termId: "routines-t", label: "t" });
  const ws = fakeSocket();
  watch(relay, ws);
  ws.readyState = 2; // CLOSING
  t.mock.timers.tick(200_000);
  assert.equal(ws.pings, 0);
  assert.equal(ws.terminated, false, "already closing — 'close' fires on its own");
  relay.stop();
});

test("connectionStatus reports up/quiet only while the socket is open", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_700_000_000_000 });
  const relay: any = new RelayClient({} as any, { termId: "routines-t", label: "t" });
  assert.deepEqual(relay.connectionStatus(), { connected: false }, "no socket → not connected");

  const ws = fakeSocket();
  relay.ws = ws;
  relay.connectedAt = Date.now();
  relay.lastInboundAt = Date.now();
  t.mock.timers.tick(30_000);
  const s = relay.connectionStatus();
  assert.equal(s.connected, true);
  assert.equal(s.upSec, 30);
  assert.equal(s.quietSec, 30);
});

test("describeRelay: says plainly when the app cannot see this harbor", () => {
  assert.match(
    describeRelay({ termId: "routines-abc", connected: false, detail: "no account signed in on this machine" }),
    /NOT connected — the app shows this Harbor as inactive \(no account signed in on this machine\)/,
  );
  assert.match(
    describeRelay({ termId: "routines-abc", connected: true, upSec: 7200, quietSec: 3 }),
    /^connected — drivable from the Privateer app \(routines-abc, up 2h 0m\)$/,
  );
  // A connected socket that has heard nothing for longer than the server's 25s ping
  // cadence is the half-open shape — don't report a flat "connected".
  assert.match(describeRelay({ termId: "routines-abc", connected: true, quietSec: 60 }), /quiet for 60s/);
  // An older harbor answering IPC has no relay block at all; don't claim either way.
  assert.match(describeRelay(undefined), /unknown/i);
});

test("formatDuration: readable at every scale", () => {
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(600), "10m");
  assert.equal(formatDuration(3_660), "1h 1m");
  assert.equal(formatDuration(144_628), "1d 16h");
});
