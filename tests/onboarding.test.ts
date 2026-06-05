import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { Onboarding, type OnboardingResult } from "../src/components/Onboarding.tsx";

const ENTER = "\r";
const ESC = "\x1b";

async function until(pred: () => boolean, timeout = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
}
const has = (lastFrame: () => string | undefined, re: RegExp) => () => re.test(lastFrame() ?? "");

// Write a keystroke with a settle before it. ink-testing-library drops writes that
// land too close together, and the input handler subscribes on a mount effect, so a
// consistent gap before each key makes the sequence deterministic under load.
async function press(stdin: any, s: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 120));
  stdin.write(s);
}

// Toggle a checkbox-style selection on, retrying if a keystroke is dropped.
// Safe because we re-check before each press, so it converges to "on".
async function selectOn(
  stdin: any,
  lastFrame: () => string | undefined,
  onRe: RegExp,
): Promise<boolean> {
  for (let i = 0; i < 6 && !onRe.test(lastFrame() ?? ""); i++) {
    await press(stdin, " ");
    await until(() => onRe.test(lastFrame() ?? ""), 400);
  }
  return onRe.test(lastFrame() ?? "");
}

test("Onboarding collects a masked key then opens the model step", async () => {
  let result: OnboardingResult | null = null;
  const { stdin, lastFrame, unmount } = render(
    React.createElement(Onboarding, { onComplete: (r: OnboardingResult) => (result = r) }),
  );
  assert.ok(await until(has(lastFrame, /Select the providers/)), "select step renders");

  // Select step shows every supported provider.
  const frame = lastFrame() ?? "";
  for (const label of ["Anthropic", "OpenAI", "OpenRouter", "Ollama"]) {
    assert.match(frame, new RegExp(label));
  }

  // Cursor starts on the first provider (OpenRouter). Toggle it on and confirm.
  assert.ok(await selectOn(stdin, lastFrame, /❯ ◉ OpenRouter/), "OpenRouter toggles on");
  await press(stdin, ENTER);
  assert.ok(await until(has(lastFrame, /Step 1 of 1/)), "advances to the key step");

  // Type a key and submit.
  for (const ch of "sk-test-123") await press(stdin, ch);
  assert.ok(await until(has(lastFrame, /\*{11}/)), "key renders masked");
  await press(stdin, ENTER);
  assert.ok(await until(has(lastFrame, /Choose your default model/)), "advances to the model step");
  assert.equal(result, null, "should wait for a model choice before completing");

  // Esc backs out of the picker and falls back to the provider's catalog default.
  await press(stdin, ESC);
  assert.ok(await until(() => result !== null), "onComplete fires after the model step");
  assert.equal(result!.providers.openrouter?.apiKey, "sk-test-123");
  assert.equal(result!.defaultModel, "openrouter:anthropic/claude-opus-4.8");
  unmount();
});

test("Onboarding masks the key input", async () => {
  const { stdin, lastFrame, unmount } = render(
    React.createElement(Onboarding, { onComplete: () => {} }),
  );
  assert.ok(await until(has(lastFrame, /Select the providers/)));
  assert.ok(await selectOn(stdin, lastFrame, /❯ ◉ OpenRouter/)); // select first provider
  await press(stdin, ENTER); // confirm → key step
  assert.ok(await until(has(lastFrame, /Step 1 of 1/)));
  for (const ch of "secret") await press(stdin, ch);
  assert.ok(await until(has(lastFrame, /\*{6}/)), "key should render as asterisks");
  assert.doesNotMatch(lastFrame() ?? "", /secret/, "raw key must not be visible");
  unmount();
});
