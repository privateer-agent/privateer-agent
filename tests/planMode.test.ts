import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { buildSystemPrompt } from "../src/context/systemPrompt.ts";
import { PlanConfirm } from "../src/components/PlanConfirm.tsx";

test("planMode adds the read-only plan mandate to the system prompt", () => {
  const opts = { cwd: process.cwd(), model: "anthropic:claude-opus-4-8" };
  assert.doesNotMatch(buildSystemPrompt(opts), /Plan mode is active/);
  assert.match(buildSystemPrompt({ ...opts, planMode: true }), /Plan mode is active/);
});

async function until(pred: () => boolean, timeout = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
}

test("PlanConfirm: 'a' approves, 'k' keeps planning", async () => {
  let approved = 0;
  let kept = 0;
  // Resend the key only if it hasn't taken effect yet — guards against the first
  // keystroke being lost before Ink subscribes, without risk of a double-fire.
  const pressUntil = async (stdin: any, key: string, check: () => boolean) => {
    for (let i = 0; i < 6 && !check(); i++) {
      stdin.write(key);
      await until(check, 500);
    }
    return check();
  };

  const a = render(
    React.createElement(PlanConfirm, { onApprove: () => approved++, onKeep: () => kept++ }),
  );
  assert.ok(await pressUntil(a.stdin, "a", () => approved === 1), "approve fires");
  a.unmount();

  const b = render(
    React.createElement(PlanConfirm, { onApprove: () => approved++, onKeep: () => kept++ }),
  );
  assert.ok(await pressUntil(b.stdin, "k", () => kept === 1), "keep fires");
  b.unmount();
});
