// The adapter's error path — the one that decides whether a failed turn is visible
// in the APP at all.
//
// Pi reports a dead model call as an assistant message with stopReason "error" and
// an errorMessage, and then resolves prompt() normally. Our own pi patch widened
// that route on purpose (a hard 4xx, and a 429 that outlived the retry budget, both
// end the turn rather than re-entering the agent loop). The CLI is fine either way —
// its TUI reads the assistant message. Every app-driven surface reads EngineEvents,
// so if turn_end doesn't carry the failure out, the turn arrives as a bare `finish`
// and the driver is shown a green tick over an empty reply.
//
//   node --import tsx --test tests/engineAdapter.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { createEngineEventAdapter } from "../src/bridge/engineAdapter.ts";

const USAGE = { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 };

test("a clean turn_end emits usage + finish, and no error", () => {
  const a = createEngineEventAdapter();
  const out = a.toEngineEvents({
    type: "turn_end",
    message: { usage: USAGE, stopReason: "stop" },
  } as any);
  assert.deepEqual(out.map((e) => e.type), ["usage", "finish"]);
  assert.equal((out[1] as any).finishReason, "stop");
});

test("a FAILED turn_end emits an error event ahead of the finish", () => {
  const a = createEngineEventAdapter();
  const out = a.toEngineEvents({
    type: "turn_end",
    message: {
      usage: USAGE,
      stopReason: "error",
      errorMessage: "401 status code (no body)",
    },
  } as any);
  assert.deepEqual(out.map((e) => e.type), ["usage", "error", "finish"]);
  const err = out[1] as any;
  // describeErrorText recovers the status and says what to do about it.
  assert.match(err.error, /401/);
  assert.match(err.hint, /\/login/);
  // The finish still goes out, and still says the turn ended badly — the client
  // reads this too, so an older agent can't report success either.
  assert.equal((out[2] as any).finishReason, "error");
});

test("a rate limit is reported as retryable, with the delay the server asked for", () => {
  const a = createEngineEventAdapter();
  const out = a.toEngineEvents({
    type: "turn_end",
    message: {
      usage: USAGE,
      stopReason: "error",
      errorMessage: '429 status code · {"retry-after": 30}',
    },
  } as any);
  const err = out.find((e) => e.type === "error") as any;
  assert.ok(err, "a 429 turn must reach the app as an error");
  assert.equal(err.retryable, true);
  assert.match(err.hint, /30s/);
});

test("an unreadable body still produces a message rather than silence", () => {
  const a = createEngineEventAdapter();
  const out = a.toEngineEvents({
    type: "turn_end",
    message: { usage: USAGE, stopReason: "error", errorMessage: "" },
  } as any);
  const err = out.find((e) => e.type === "error") as any;
  assert.ok(err, "an error with no readable status must NOT be dropped");
  assert.ok(err.error.length > 0);
});

test("agent_end carries no error on pi 0.84 and must stay silent", () => {
  const a = createEngineEventAdapter();
  // The real shape: { messages, willRetry }. The turn-level mapping above is the
  // error path; this branch must not start inventing a second one.
  assert.deepEqual(a.toEngineEvents({ type: "agent_end", messages: [], willRetry: false } as any), []);
});
