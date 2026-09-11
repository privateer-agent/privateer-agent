// Pi steps/retries are not whole runs. Only agent_settled closes the app turn.
// node --import tsx --test tests/engineAdapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngineEventAdapter } from "../src/bridge/engineAdapter.ts";

const USAGE = { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 };
const end = (a: ReturnType<typeof createEngineEventAdapter>, stopReason = "stop", errorMessage?: string) =>
  a.toEngineEvents({ type: "turn_end", message: { usage: USAGE, stopReason, errorMessage } });
const settle = (a: ReturnType<typeof createEngineEventAdapter>) => a.toEngineEvents({ type: "agent_settled" });

test("a clean step emits usage, but only settlement emits finish once", () => {
  const a = createEngineEventAdapter();
  assert.deepEqual(end(a).map((e) => e.type), ["usage", "step-finish"]);
  assert.deepEqual(settle(a).map((e) => e.type), ["finish"]);
  assert.deepEqual(settle(a), []);
});

test("failed calls stay nonterminal until settled, then report actionable errors", () => {
  const a = createEngineEventAdapter();
  assert.deepEqual(end(a, "error", "401 status code (no body)").map((e) => e.type), ["usage", "step-finish"]);
  const out = settle(a);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "error");
  if (out[0].type !== "error") return;
  assert.match(out[0].error, /401/);
  assert.match(out[0].hint!, /\/login/);
});

test("an exhausted rate limit preserves the retry hint", () => {
  const a = createEngineEventAdapter();
  end(a, "error", '429 status code · {"retry-after": 30}');
  const err = settle(a)[0];
  assert.equal(err.type, "error");
  if (err.type !== "error") return;
  assert.equal(err.retryable, true);
  assert.match(err.hint!, /30s/);
});

test("an unreadable error body still produces a message", () => {
  const a = createEngineEventAdapter();
  end(a, "error", "");
  const err = settle(a)[0];
  assert.ok(err.type === "error" && err.error.length > 0);
});

test("tool loop, retry and compaction continuation produce one whole-run finish", () => {
  const a = createEngineEventAdapter();
  a.toEngineEvents({ type: "agent_start" });
  end(a, "toolUse");
  end(a, "error", "503 temporary failure");
  assert.deepEqual(a.toEngineEvents({ type: "agent_end", messages: [], willRetry: true }), []);
  assert.equal(a.toEngineEvents({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 50 })[0].type, "retrying");
  a.toEngineEvents({ type: "agent_start" }); // retry does not reset run usage
  end(a, "length");
  assert.deepEqual(a.toEngineEvents({ type: "agent_end", messages: [], willRetry: false }), []);
  a.toEngineEvents({ type: "agent_start" }); // overflow recovery
  const usage = end(a)[0];
  assert.ok(usage.type === "usage" && usage.turn.inputTokens === 40);
  assert.equal(settle(a)[0].type, "finish", "a successful retry must not emit the recovered error");
  a.toEngineEvents({ type: "agent_start" });
  const next = end(a)[0];
  assert.ok(next.type === "usage" && next.turn.inputTokens === 10 && next.usage.inputTokens === 50);
  assert.equal(settle(a)[0].type, "finish");
});

test("aborted assistant message settles as interrupted, not done", () => {
  const a = createEngineEventAdapter();
  end(a, "aborted");
  assert.deepEqual(settle(a), [{ type: "aborted" }]);
  assert.deepEqual(a.toEngineEvents({ type: "aborted" }), []);
  a.toEngineEvents({ type: "agent_start" });
  assert.deepEqual(a.toEngineEvents({ type: "abort" }), [{ type: "aborted" }]);
  assert.deepEqual(settle(a), []);
});

test("partial tool output is snapshot progress, never a result", () => {
  const a = createEngineEventAdapter();
  const update = (text: string) => a.toEngineEvents({ type: "tool_execution_update", toolCallId: "b1", toolName: "bash", partialResult: { content: [{ type: "text", text }] } });
  assert.deepEqual(update("one"), [{ type: "tool-progress", id: "b1", name: "bash", output: "one" }]);
  assert.equal((update("x".repeat(5000) + "tail")[0] as any).output, "x".repeat(5000) + "tail", "cloud redaction must receive the full snapshot before clipping");
  assert.equal(a.toEngineEvents({ type: "tool_execution_update", toolCallId: "b1", toolName: "bash" })[0].type, "tool-progress");
  const out = a.toEngineEvents({ type: "tool_execution_end", toolCallId: "b1", toolName: "bash", result: "done" });
  assert.equal(out[0].type, "tool-result");
});
