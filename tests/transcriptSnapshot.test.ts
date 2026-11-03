import { test } from "node:test";
import assert from "node:assert/strict";
import { transcriptSnapshot } from "../src/remote/transcriptSnapshot.ts";

// What a reattaching app is sent instead of a lone "connected" notice: the session's
// branch, projected into the live feed's entry kinds so its stale copy can be replaced.
const msg = (message: any) => ({ type: "message", message });

test("a branch projects into you / reasoning / assistant / tool entries, results paired by id", () => {
  const out = transcriptSnapshot([
    { type: "model_change" },
    msg({ role: "user", content: "find the bug" }),
    msg({ role: "assistant", content: [
      { type: "thinking", thinking: "look at the log" },
      { type: "text", text: "Checking." },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
    ] }),
    msg({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false }),
    msg({ role: "assistant", content: [{ type: "text", text: "Found it." }], stopReason: "stop" }),
  ]);
  assert.deepEqual(out.map((e) => e.kind), ["you", "reasoning", "assistant", "tool", "assistant"]);
  assert.equal(out[3].tool?.output, "a.txt");
  assert.equal(out[3].tool?.running, false);
  assert.equal(out[3].tool?.input, '{"command":"ls"}');
});

test("a call with no result yet stays running; an error result is an error", () => {
  const out = transcriptSnapshot([
    msg({ role: "assistant", content: [
      { type: "toolCall", id: "a", name: "read", arguments: {} },
      { type: "toolCall", id: "b", name: "ask_user_question", arguments: {} },
    ] }),
    msg({ role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "ENOENT" }], isError: true }),
  ]);
  assert.equal(out[0].tool?.error, "ENOENT");
  assert.equal(out[1].tool?.running, true);
});

test("a compaction drops what came before it; blank and redacted text is skipped", () => {
  const out = transcriptSnapshot([
    msg({ role: "user", content: "old" }),
    { type: "compaction", summary: "…" },
    msg({ role: "user", content: [{ type: "text", text: "  " }] }),
    msg({ role: "assistant", content: [{ type: "thinking", thinking: "x", redacted: true }, { type: "text", text: "new" }] }),
  ]);
  assert.deepEqual(out.map((e) => e.kind), ["notice", "assistant"]);
});

test("a failed model call leaves its error in the transcript", () => {
  const out = transcriptSnapshot([msg({ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited" })]);
  assert.deepEqual(out, [{ kind: "notice", text: "⚠ 429 rate limited" }]);
});
