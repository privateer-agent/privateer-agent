import { test } from "node:test";
import assert from "node:assert/strict";
import { Config } from "../src/config/schema.ts";
import {
  modelSupportsVision,
  suggestVisionModel,
  modelSupports,
  modalitiesFor,
  suggestModelFor,
} from "../src/providers/capabilities.ts";

test("modelSupportsVision recognizes common vision families across providers", () => {
  // Anthropic: Claude 3.x / 4.x yes; Claude 2 no.
  assert.equal(modelSupportsVision("anthropic", "claude-opus-4-8"), true);
  assert.equal(modelSupportsVision("anthropic", "claude-3-5-sonnet-latest"), true);
  assert.equal(modelSupportsVision("anthropic", "claude-2.1"), false);
  // OpenAI: 4o / 5 yes; 3.5 no.
  assert.equal(modelSupportsVision("openai", "gpt-4o"), true);
  assert.equal(modelSupportsVision("openai", "gpt-5.5"), true);
  assert.equal(modelSupportsVision("openai", "gpt-3.5-turbo"), false);
  // OpenRouter ids carry a vendor prefix.
  assert.equal(modelSupportsVision("openrouter", "google/gemini-2.5-flash"), true);
  assert.equal(modelSupportsVision("openrouter", "qwen/qwen2.5-vl-72b-instruct"), true);
  assert.equal(modelSupportsVision("openrouter", "mistralai/pixtral-12b"), true);
  assert.equal(modelSupportsVision("openrouter", "minimax/minimax-m3"), false);
});

test("modelSupportsVision trusts reported modalities over the heuristic", () => {
  // A model the heuristic would reject, but the provider says accepts images.
  assert.equal(modelSupportsVision("openrouter", "minimax/minimax-m3", ["text", "image"]), true);
  // And vice-versa: heuristic would accept, but modalities say text-only.
  assert.equal(modelSupportsVision("openai", "gpt-4o", ["text"]), false);
});

test("suggestVisionModel picks a vision-capable model from a configured provider", () => {
  // Default is a text-only OpenRouter model; OpenRouter is configured, so its
  // catalog default (a vision-capable Claude route) is suggested.
  const cfg = Config.parse({
    defaultModel: "openrouter:minimax/minimax-m3",
    providers: { openrouter: { apiKey: "sk-or-test" } },
  });
  const spec = suggestVisionModel(cfg);
  assert.ok(spec, "a suggestion is returned");
  assert.match(spec!, /^openrouter:/);
});

test("suggestVisionModel returns null when no provider is configured", () => {
  const cfg = Config.parse({ defaultModel: "openrouter:minimax/minimax-m3", providers: {} });
  assert.equal(suggestVisionModel(cfg), null);
});

test("modelSupports differentiates modalities per family", () => {
  // Anthropic: image + document, but not audio/video.
  assert.equal(modelSupports("image", "anthropic", "claude-opus-4-8"), true);
  assert.equal(modelSupports("document", "anthropic", "claude-opus-4-8"), true);
  assert.equal(modelSupports("audio", "anthropic", "claude-opus-4-8"), false);
  assert.equal(modelSupports("video", "anthropic", "claude-opus-4-8"), false);
  // Gemini: all four.
  assert.equal(modelSupports("video", "openrouter", "google/gemini-2.5-flash"), true);
  assert.equal(modelSupports("audio", "openrouter", "google/gemini-2.5-flash"), true);
  // OpenAI audio model.
  assert.equal(modelSupports("audio", "openai", "gpt-4o-audio-preview"), true);
  assert.equal(modelSupports("video", "openai", "gpt-4o-audio-preview"), false);
});

test("modelSupports trusts reported modalities, and modalitiesFor returns the set", () => {
  assert.equal(modelSupports("audio", "x", "y", ["text", "audio"]), true);
  assert.equal(modelSupports("image", "x", "y", ["text", "audio"]), false);
  assert.deepEqual(
    [...modalitiesFor("openrouter", "google/gemini-2.5-flash")].sort(),
    ["audio", "document", "image", "video"],
  );
});

test("suggestModelFor finds a capable model per modality", () => {
  const cfg = Config.parse({
    defaultModel: "openrouter:minimax/minimax-m3",
    providers: { openrouter: { apiKey: "sk-or-test" } },
  });
  // OpenRouter's catalog default (a Claude route) covers image + document.
  assert.match(suggestModelFor("document", cfg) ?? "", /^openrouter:/);
  assert.match(suggestModelFor("image", cfg) ?? "", /^openrouter:/);
});
