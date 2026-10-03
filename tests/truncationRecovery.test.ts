import { test } from "node:test";
import assert from "node:assert/strict";
import { isRecoverableLength } from "@earendil-works/pi-ai/compat";
import {
  MAX_AUTO_CONTINUES,
  continuationPrompt,
  decideTruncationRecovery,
  isFullBudgetLengthStop,
} from "../src/engine/truncationRecovery.ts";
import privateerTruncation from "../extensions/privateer-truncation.ts";

// A run that ends on a full-budget length stop used to just stop: pi only
// compact-and-retries a length stop that ended BELOW the budget. See
// src/engine/truncationRecovery.ts.

const MAX = 16384;
const assistant = (stopReason: string, output: number, content: { type: string }[] = [{ type: "thinking" }]) => ({
  role: "assistant",
  stopReason,
  usage: { output },
  content,
});

test("only a length stop that used the whole budget is ours", () => {
  assert.equal(isFullBudgetLengthStop(assistant("length", MAX), MAX), true);
  // The real shape from session logs: thinking ate 16384 of 16384.
  assert.equal(isFullBudgetLengthStop(assistant("length", MAX + 3), MAX), true);
  for (const m of [assistant("stop", MAX), assistant("toolUse", MAX), assistant("error", 0), assistant("aborted", MAX)]) {
    assert.equal(isFullBudgetLengthStop(m, MAX), false, m.stopReason);
  }
  // An unknown budget: we cannot tell, so leave it alone.
  assert.equal(isFullBudgetLengthStop(assistant("length", MAX), 0), false);
});

test("the split with pi's own recovery is exact — never both, never neither", () => {
  // Below the budget pi compacts and retries; at it, pi gives up and we take over.
  // A gap would leave a stop unhandled; an overlap would continue twice.
  for (const output of [0, 1, 1024, MAX - 1, MAX, MAX + 1]) {
    const m = assistant("length", output) as any;
    assert.notEqual(isRecoverableLength(m, MAX), isFullBudgetLengthStop(m, MAX), `output=${output}`);
  }
});

test("continues up to the cap, then gives up", () => {
  const msgs = [{ role: "user" }, assistant("length", MAX)];
  for (let n = 0; n < MAX_AUTO_CONTINUES; n++) {
    const d = decideTruncationRecovery(msgs, MAX, n);
    assert.equal(d.action, "continue");
    assert.equal((d as any).attempt, n + 1);
  }
  assert.equal(decideTruncationRecovery(msgs, MAX, MAX_AUTO_CONTINUES).action, "give-up");
  assert.equal(decideTruncationRecovery([assistant("stop", 10)], MAX, 0).action, "none");
  assert.equal(decideTruncationRecovery(undefined, MAX, 0).action, "none");
});

test("the follow-up says what the model needs to do differently", () => {
  assert.match(continuationPrompt(assistant("length", MAX, [{ type: "thinking" }])), /spent entirely on reasoning/);
  assert.match(continuationPrompt(assistant("length", MAX, [{ type: "thinking" }, { type: "toolCall" }])), /issue it again/);
  assert.match(continuationPrompt(assistant("length", MAX, [{ type: "text" }])), /where you left off/);
});

function fakePi() {
  const handlers: Record<string, (ev: any, ctx: any) => void> = {};
  const sent: { message: any; options: any }[] = [];
  const notes: { text: string; level: string }[] = [];
  const pi = {
    on: (name: string, fn: any) => (handlers[name] = fn),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  privateerTruncation(pi);
  const ctx = { model: { maxTokens: MAX }, ui: { notify: (text: string, level: string) => notes.push({ text, level }) } };
  const end = (m: any) => handlers.agent_end({ messages: [{ role: "user" }, m] }, ctx);
  return { handlers, sent, notes, end };
}

test("the extension queues a follow-up that pi continues in the same run", () => {
  const { sent, end } = fakePi();
  end(assistant("length", MAX));
  assert.equal(sent.length, 1);
  // followUp + triggerTurn while the run is active → agent.followUp → hasQueuedMessages
  // → pi's post-run loop continues. Anything else would wait for the user.
  assert.deepEqual(sent[0].options, { deliverAs: "followUp", triggerTurn: true });
  assert.equal(sent[0].message.customType, "privateer-truncation");
});

test("the extension is bounded, and a typed message re-arms it", () => {
  const { sent, notes, end, handlers } = fakePi();
  for (let i = 0; i < MAX_AUTO_CONTINUES + 3; i++) end(assistant("length", MAX));
  assert.equal(sent.length, MAX_AUTO_CONTINUES, "a model that truncates every time must not loop forever");
  assert.equal(notes.at(-1)?.level, "warning");

  handlers.input({}, {});
  end(assistant("length", MAX));
  assert.equal(sent.length, MAX_AUTO_CONTINUES + 1);
});

test("a reply that finishes resets the count", () => {
  const { sent, end } = fakePi();
  end(assistant("length", MAX));
  end(assistant("stop", 200, [{ type: "text" }]));
  end(assistant("length", MAX));
  end(assistant("length", MAX));
  assert.equal(sent.length, 3);
});

test("pi's own recovery case is left to pi", () => {
  const { sent, end } = fakePi();
  end(assistant("length", 1));
  end(assistant("length", 0, []));
  assert.equal(sent.length, 0);
});
