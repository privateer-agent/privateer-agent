// Vision delegation (src/providers/visionDelegate.ts): a text-only model's images are
// described by a vision model on the SAME provider, never another one.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearVisionCache,
  describeImagesInMessages,
  pickVisionDelegate,
  type VisionModel,
  type VisionRegistry,
} from "../src/providers/visionDelegate.ts";

const m = (provider: string, id: string, vision: boolean): VisionModel => ({
  provider,
  id,
  input: vision ? ["text", "image"] : ["text"],
});

function registry(models: VisionModel[], opts: { noAuth?: string[]; reply?: (ctx: any) => any } = {}) {
  const calls: Array<{ model: VisionModel; ctx: any }> = [];
  const reg: VisionRegistry & { calls: typeof calls } = {
    calls,
    getAvailable: () => models.filter((x) => reg.hasConfiguredAuth(x)),
    find: (p, id) => models.find((x) => x.provider === p && x.id === id),
    hasConfiguredAuth: (x) => !(opts.noAuth ?? []).includes(x.provider),
    complete: async (model, ctx) => {
      calls.push({ model, ctx });
      return opts.reply?.(ctx) ?? { content: [{ type: "text", text: "a red button labelled OK" }], stopReason: "stop" };
    },
  };
  return reg;
}

const NO_ENV = {} as NodeJS.ProcessEnv;

beforeEach(() => clearVisionCache());

test("a model that can see gets no delegate", () => {
  const reg = registry([m("privateer", "tinfoil/gemma4-31b", true)]);
  assert.equal(pickVisionDelegate(m("privateer", "anthropic/claude-x", true), reg, NO_ENV), undefined);
});

test("account channel prefers the confidential Tinfoil default", () => {
  const reg = registry([
    m("privateer", "anthropic/claude-x", true),
    m("privateer", "tinfoil/gemma4-31b", true),
    m("privateer", "glm-5-2", false),
  ]);
  const d = pickVisionDelegate(m("privateer", "glm-5-2", false), reg, NO_ENV);
  assert.equal(d?.id, "tinfoil/gemma4-31b");
});

test("direct Tinfoil key delegates to tinfoil/gemma4-31b", () => {
  const reg = registry([m("tinfoil", "kimi-k2-6", false), m("tinfoil", "gemma4-31b", true)]);
  const d = pickVisionDelegate(m("tinfoil", "kimi-k2-6", false), reg, NO_ENV);
  assert.deepEqual([d?.provider, d?.id], ["tinfoil", "gemma4-31b"]);
});

test("never crosses providers, even when another key has a vision model", () => {
  const reg = registry([m("tinfoil", "glm-5-2", false), m("anthropic", "claude-opus-4-8", true)]);
  assert.equal(pickVisionDelegate(m("tinfoil", "glm-5-2", false), reg, NO_ENV), undefined);
});

test("falls back to any vision model the same provider serves", () => {
  const reg = registry([m("openrouter", "meta/text", false), m("openrouter", "x-ai/grok-4", true)]);
  assert.equal(pickVisionDelegate(m("openrouter", "meta/text", false), reg, NO_ENV)?.id, "x-ai/grok-4");
});

test("a vision model without working auth is skipped", () => {
  const reg = registry([m("privateer", "glm-5-2", false), m("privateer", "tinfoil/gemma4-31b", true)], {
    noAuth: ["privateer"],
  });
  assert.equal(pickVisionDelegate(m("privateer", "glm-5-2", false), reg, NO_ENV), undefined);
});

test("PRIVATEER_VISION_MODEL overrides the pick", () => {
  const reg = registry([
    m("tinfoil", "glm-5-2", false),
    m("tinfoil", "gemma4-31b", true),
    m("anthropic", "claude-opus-4-8", true),
  ]);
  const d = pickVisionDelegate(m("tinfoil", "glm-5-2", false), reg, { PRIVATEER_VISION_MODEL: "anthropic/claude-opus-4-8" });
  assert.equal(d?.provider, "anthropic");
});

const IMG = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

test("images become descriptions; the omitted note is stripped; the input is untouched", async () => {
  const reg = registry([]);
  const delegate = m("tinfoil", "gemma4-31b", true);
  const messages = [
    { role: "user", content: [{ type: "text", text: "what's wrong here?" }, IMG] },
    { role: "assistant", content: [{ type: "text", text: "let me read it" }] },
    {
      role: "toolResult",
      content: [
        { type: "text", text: "Read image file [image/png]\n[Current model does not support images. The image will be omitted from this request.]" },
        { ...IMG, data: "d29ybGQ=" },
      ],
    },
  ];
  const before = JSON.stringify(messages);
  const out = await describeImagesInMessages(messages, delegate, reg, { currentSpec: "tinfoil/glm-5-2" });
  assert.equal(JSON.stringify(messages), before, "the session's own messages must not be mutated");
  assert.ok(out);
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes('"type":"image"'));
  assert.ok(!flat.includes("does not support images"));
  assert.match(out![0].content[1].text, /tinfoil\/gemma4-31b described it:\]\na red button/);
  assert.equal(out![2].content[0].text, "Read image file [image/png]");
  assert.equal(reg.calls.length, 2);
  // The surrounding text travels with the image as context.
  assert.match(JSON.stringify(reg.calls[0].ctx.messages[0].content[0]), /what's wrong here/);
});

test("the same image is described once across turns", async () => {
  const reg = registry([]);
  const delegate = m("tinfoil", "gemma4-31b", true);
  const messages = [{ role: "user", content: [IMG] }];
  await describeImagesInMessages(messages, delegate, reg, { currentSpec: "x" });
  await describeImagesInMessages(messages, delegate, reg, { currentSpec: "x" });
  assert.equal(reg.calls.length, 1);
});

test("a failed description becomes a note and is retried next turn", async () => {
  let fail = true;
  const reg = registry([], {
    reply: () => (fail ? { content: [], stopReason: "error", errorMessage: "429" } : undefined),
  });
  const delegate = m("tinfoil", "gemma4-31b", true);
  const messages = [{ role: "user", content: [IMG] }];
  const first = await describeImagesInMessages(messages, delegate, reg, { currentSpec: "x" });
  assert.match(first![0].content[0].text, /could not describe it: 429/);
  fail = false;
  const second = await describeImagesInMessages(messages, delegate, reg, { currentSpec: "x" });
  assert.match(second![0].content[0].text, /a red button/);
});

test("no images → nothing to rewrite", async () => {
  const reg = registry([]);
  const out = await describeImagesInMessages([{ role: "user", content: "hi" }], m("t", "v", true), reg, { currentSpec: "x" });
  assert.equal(out, undefined);
  assert.equal(reg.calls.length, 0);
});
