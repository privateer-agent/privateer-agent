import { test } from "node:test";
import assert from "node:assert/strict";

// Which --model the launcher hands Pi (bin/model-args.mjs). The case that matters: a
// saved privateer/* pick is passed explicitly, because Pi only honours a saved default
// whose provider has auth at that instant — and the account's auth.json entry vanishes
// whenever another Privateer process exits, which silently put runs on OpenRouter.
const { modelArgs } = await import("../bin/model-args.mjs");
const computed = "privateer/tinfoil/gemma4-31b";

test("a signed-in privateer pick is passed explicitly", () => {
  assert.deepEqual(
    modelArgs({ launchArgs: ["-p", "x"], savedDefault: "privateer/near/Qwen/Qwen3.8-27B", signedIn: true, computed }),
    ["--model", "privateer/near/Qwen/Qwen3.8-27B"],
  );
});

test("other saved picks are left to Pi, which falls back when they vanish", () => {
  assert.deepEqual(modelArgs({ launchArgs: [], savedDefault: "anthropic/claude-opus-4-8", signedIn: true, computed }), []);
  assert.deepEqual(modelArgs({ launchArgs: [], savedDefault: "privateer/near/x", signedIn: false, computed }), []);
});

test("the user's --model and PRIVATEER_MODEL still win", () => {
  assert.deepEqual(
    modelArgs({ launchArgs: ["--model", "ollama/qwen3"], savedDefault: "privateer/near/x", signedIn: true, computed }),
    [],
  );
  assert.deepEqual(
    modelArgs({ launchArgs: [], envModel: "openai/gpt-5.5", savedDefault: "privateer/near/x", signedIn: true, computed: "openai/gpt-5.5" }),
    ["--model", "openai/gpt-5.5"],
  );
});

test("nothing saved → the computed default", () => {
  assert.deepEqual(modelArgs({ launchArgs: [], savedDefault: null, signedIn: true, computed }), ["--model", computed]);
});
