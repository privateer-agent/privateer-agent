import { test } from "node:test";
import assert from "node:assert/strict";
import { packSource, MAX_SOURCE_PROMPT, type OutboxSource } from "../src/outbox/cloudOutbox.ts";

// `source` is what makes a delivered result ACTIONABLE: the app reads it to build a
// follow-up task that runs where the routine ran, with the routine's own standing
// instruction in hand. It rides inside the sealed envelope on EVERY result, which is
// why the clipping below is not cosmetic — an unbounded routine prompt would eat the
// envelope budget that attachments and the answer itself are sized against.

test("packSource keeps the fields a follow-up needs", () => {
  const packed = packSource({
    routineId: "r-123-abcd",
    prompt: "Summarize overnight security advisories for our stack.",
    cwd: "/Users/me/work/api",
    model: "privateer/near/zai-org/GLM-5.1-FP8",
    schedule: "0 7 * * *",
  });
  assert.deepEqual(packed, {
    routineId: "r-123-abcd",
    prompt: "Summarize overnight security advisories for our stack.",
    cwd: "/Users/me/work/api",
    model: "privateer/near/zai-org/GLM-5.1-FP8",
    schedule: "0 7 * * *",
  });
});

test("packSource clips a long prompt rather than shipping it whole", () => {
  const packed = packSource({ prompt: "x".repeat(MAX_SOURCE_PROMPT * 3) });
  assert.ok(packed?.prompt);
  assert.equal(packed.prompt.length, MAX_SOURCE_PROMPT + 1); // + the ellipsis
  assert.ok(packed.prompt.endsWith("…"));
});

test("packSource drops empty and non-string fields", () => {
  const packed = packSource({
    prompt: "  do the thing  ",
    cwd: "   ",
    model: undefined,
    // A hand-edited routines.json can hold anything; the envelope must not.
    schedule: 7 as unknown as string,
  });
  assert.deepEqual(packed, { prompt: "do the thing" });
});

test("packSource returns undefined when there is nothing to say", () => {
  // A workflow run, or a live spawn with no initial prompt — the envelope should
  // carry no `source` key at all rather than an empty object claiming context.
  assert.equal(packSource(undefined), undefined);
  assert.equal(packSource({}), undefined);
  assert.equal(packSource({ prompt: "", cwd: "  " } as OutboxSource), undefined);
});
