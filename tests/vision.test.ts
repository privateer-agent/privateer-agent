import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acceptsImages, visionInput } from "../src/providers/vision.ts";

// The account catalog as the server actually returned it, so these cases are about
// real ids rather than ones invented to fit the patterns.
const CATALOG: string[] = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "account-models.json"), "utf8"),
).ids;

test("acceptsImages: the models that can see", () => {
  for (const id of [
    // The default, all three homes it is served from, plus the bare Tinfoil id the
    // direct provider registers.
    "tinfoil/gemma4-31b",
    "near/google/gemma-4-31B-it",
    "phala/google/gemma-4-31b-it",
    "google/gemma-4-31b-it",
    // Vision spelled out in the id.
    "near/Qwen/Qwen3-VL-30B-A3B-Instruct",
    "qwen/qwen3-vl-235b-a22b-thinking",
    "qwen/qwen2.5-vl-72b-instruct",
    "baidu/ernie-4.5-vl-424b-a47b",
    "z-ai/glm-4.5v",
    "z-ai/glm-5v-turbo",
    "bytedance/ui-tars-1.5-7b",
    // Families that are multimodal throughout.
    "anthropic/claude-3-haiku",
    "anthropic/claude-opus-5",
    "google/gemini-2.5-pro",
    "google/gemini-3.7-flash",
    "openai/gpt-4o-mini",
    "openai/gpt-4.1",
    "openai/gpt-5.6-sol",
    "meta-llama/llama-4-maverick",
    "amazon/nova-pro-v1",
    "amazon/nova-2-lite-v1",
    "x-ai/grok-4.6",
    "mistralai/mistral-small-3.2-24b-instruct",
    "mistralai/mistral-medium-3.1",
  ]) {
    assert.ok(acceptsImages(id), `${id} should accept images`);
  }
});

test("acceptsImages: the text-only near-misses", () => {
  // Each of these sits one character from a vision id, and claiming image support it
  // doesn't have costs a 400 on a real turn — the expensive direction of the two.
  for (const id of [
    "tinfoil/gpt-oss-120b", // the former default: open-weights gpt-oss is text-only
    "openai/gpt-oss-120b",
    "openai/gpt-4", // the original, unlike gpt-4o
    "openai/gpt-3.5-turbo-16k",
    "google/gemma-2-27b-it", // Gemma only became multimodal at 3
    "z-ai/glm-5.2", // the text sibling of glm-5v-turbo
    "tinfoil/glm-5-2",
    "near/zai-org/GLM-5.1-FP8",
    "qwen/qwen3.8-27b", // Qwen ships vision as a separate VL line
    "near/Qwen/Qwen3.8-27B",
    "meta-llama/llama-3.3-70b-instruct",
    "amazon/nova-micro-v1",
    "deepseek/deepseek-v4-pro",
    "moonshotai/kimi-k3",
    "tinfoil/llama3-3-70b",
  ]) {
    assert.ok(!acceptsImages(id), `${id} should NOT be claimed as multimodal`);
  }
});

test("acceptsImages classifies a minority of the live catalog", () => {
  // A guard on the patterns, not on the count: a regex that got too greedy (a bare
  // /v/ or /4/) would sweep up most of 250-odd ids, and nothing else here would catch
  // it. The catalog is overwhelmingly text-only, so anything near half is a bug.
  const seen = CATALOG.filter(acceptsImages).length;
  assert.ok(seen > 20, `expected the known vision families to match, saw ${seen}`);
  assert.ok(seen < CATALOG.length / 2, `patterns are over-matching: ${seen}/${CATALOG.length}`);
});

test("visionInput always keeps text, and adds image only when earned", () => {
  assert.deepEqual(visionInput("tinfoil/gemma4-31b"), ["text", "image"]);
  assert.deepEqual(visionInput("tinfoil/gpt-oss-120b"), ["text"]);
  // Pi reads this field directly (model.input.includes("image")); an entry that lost
  // "text" would be a model Pi thinks cannot be sent a prompt.
  for (const id of CATALOG) assert.ok(visionInput(id).includes("text"), id);
});
