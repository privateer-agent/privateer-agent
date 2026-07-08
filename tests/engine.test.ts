import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryEngine, estimateTokens, formatCompaction } from "../src/engine/QueryEngine.ts";
import type { RouteSet } from "../src/engine/router.ts";
import { createTools } from "../src/tools/index.ts";
import { autoApproveGate } from "../src/permissions/gate.ts";

// Wrap a mock model in a single-route RouteSet (what the engine now expects).
function routesFor(model: any, over: Partial<RouteSet> = {}): RouteSet {
  return {
    default: { spec: "mock:mock-1", model, cacheControl: false, label: "mock-1", supports: new Set() },
    longThreshold: Number.POSITIVE_INFINITY,
    fastMaxChars: 0,
    ...over,
  };
}

// Build a ReadableStream that emits the given AI SDK v2 stream parts in order.
function streamFrom(chunks: any[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

// Minimal hand-rolled LanguageModelV2 mock: step 1 calls the `write` tool, step 2
// emits a final text answer. Exercises the real multi-step tool loop, our tool
// execution, event normalization, and usage accumulation — no network, no test deps.
function scriptedModel(filePath: string) {
  let step = 0;
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock-1",
    supportedUrls: {},
    async doStream() {
      step++;
      if (step === 1) {
        return {
          stream: streamFrom([
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "c1",
              toolName: "write",
              input: JSON.stringify({ path: filePath, content: "hi from privateer\n" }),
            },
            { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          ]),
        };
      }
      return {
        stream: streamFrom([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Created the file." },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: "stop", usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } },
        ]),
      };
    },
  };
}

test("engine runs a full tool-call loop and accumulates usage", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "privateer-engine-"));
  try {
    const tools = createTools({ cwd, gate: autoApproveGate });
    const engine = new QueryEngine({
      routes: routesFor(scriptedModel("out.txt")),
      system: "test",
      tools,
      maxSteps: 10,
    });

    const events: string[] = [];
    let text = "";
    for await (const ev of engine.send("make the file")) {
      events.push(ev.type);
      if (ev.type === "text") text += ev.text;
      if (ev.type === "error") throw new Error(`engine error: ${ev.error}`);
    }

    assert.ok(events.includes("tool-call"), "should emit tool-call");
    assert.ok(events.includes("tool-result"), "should emit tool-result");
    assert.ok(events.includes("finish"), "should emit finish");
    assert.equal(text, "Created the file.");
    assert.ok(existsSync(join(cwd, "out.txt")), "tool actually wrote the file");
    assert.equal(readFileSync(join(cwd, "out.txt"), "utf8"), "hi from privateer\n");
    assert.ok(engine.usage.totalTokens > 0, "usage accumulated");
    assert.ok(engine.messages.length >= 2, "history persisted");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// A model that streams a single text answer reporting its own id, so a test can
// tell which route the engine actually streamed from.
function namingModel(modelId: string) {
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId,
    supportedUrls: {},
    async doStream() {
      return {
        stream: streamFrom([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: `answered-by:${modelId}` },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        ]),
      };
    },
  };
}

test("an image turn routes to the vision model and emits 'routed' (sticky)", async () => {
  const routes = routesFor(namingModel("text-default"), {
    vision: {
      spec: "mock:vision",
      model: namingModel("vision-model") as any,
      cacheControl: false,
      label: "vision-model",
      supports: new Set(["image"]),
    },
  });
  const engine = new QueryEngine({ routes, system: "s", tools: {}, maxSteps: 3 });

  let text = "";
  let routed: { label: string; reason?: string } | null = null;
  for await (const ev of engine.send("describe this", undefined, [
    { data: "abcd", mediaType: "image/png", modality: "image" },
  ])) {
    if (ev.type === "text") text += ev.text;
    if (ev.type === "routed") routed = { label: ev.label, reason: ev.reason };
  }
  assert.equal(text, "answered-by:vision-model", "streamed from the vision route");
  assert.deepEqual(routed, { label: "vision-model", reason: "image input" });

  // Sticky: a follow-up text turn still routes to vision because the image remains in history.
  let text2 = "";
  for await (const ev of engine.send("and now?")) if (ev.type === "text") text2 += ev.text;
  assert.equal(text2, "answered-by:vision-model", "stays on vision while image is in history");
});

test("a PDF turn streams a file part and routes to a document model", async () => {
  const routes = routesFor(namingModel("text-default"), {
    document: {
      spec: "mock:doc",
      model: namingModel("doc-model") as any,
      cacheControl: false,
      label: "doc-model",
      supports: new Set(["document"]),
    },
  });
  const engine = new QueryEngine({ routes, system: "s", tools: {}, maxSteps: 3 });

  let text = "";
  let reason: string | undefined;
  for await (const ev of engine.send("summarize", undefined, [
    { data: "JVBERi0=", mediaType: "application/pdf", modality: "document" },
  ])) {
    if (ev.type === "text") text += ev.text;
    if (ev.type === "routed") reason = ev.reason;
  }
  assert.equal(text, "answered-by:doc-model", "streamed from the document route");
  assert.equal(reason, "document input");
  // The pushed message carries a file part (not an image part).
  const parts = engine.messages[0].content as any[];
  assert.ok(parts.some((p) => p.type === "file" && p.mediaType === "application/pdf"));
});

// A model that answers a one-shot generate() (used by compaction's summarizer).
function summarizerModel() {
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock-1",
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text", text: "SUMMARY of earlier work" }],
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        warnings: [],
      };
    },
  };
}

test("compact replaces old history with a summary, keeping recent messages verbatim", async () => {
  const engine = new QueryEngine({ routes: routesFor(summarizerModel()), system: "s", tools: {}, maxSteps: 5 });
  for (let i = 0; i < 12; i++) {
    engine.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i} ` + "x".repeat(60) });
  }
  const before = engine.messages.length;
  const res = await engine.compact();

  assert.ok(res, "compaction ran");
  assert.ok(engine.messages.length < before, "history shrank");
  assert.equal(engine.messages[0].role, "user");
  assert.match(String(engine.messages[0].content), /Summary of earlier conversation/);
  assert.match(String(engine.messages[0].content), /SUMMARY of earlier work/);
  // The most recent message is preserved verbatim.
  assert.match(String(engine.messages.at(-1)?.content), /message 11/);
});

test("formatCompaction renders the structured summary sections", () => {
  const out = formatCompaction({
    goals: "Ship the parser",
    decisions: ["Use a recursive descent approach"],
    filesTouched: ["src/parser.ts — added tokenizer"],
    openThreads: ["Handle error recovery"],
  });
  assert.match(out, /Goals: Ship the parser/);
  assert.match(out, /Decisions:\n- Use a recursive descent/);
  assert.match(out, /Files touched:\n- src\/parser\.ts/);
  assert.match(out, /Open threads:\n- Handle error recovery/);
  // Empty arrays degrade gracefully.
  assert.match(formatCompaction({ goals: "x", decisions: [], filesTouched: [], openThreads: [] }), /- \(none\)/);
});

test("estimateTokens grows with content", () => {
  const small = estimateTokens([{ role: "user", content: "hi" }]);
  const big = estimateTokens([{ role: "user", content: "x".repeat(4000) }]);
  assert.ok(big > small + 500, "longer content estimates more tokens");
});

test("a pre-aborted turn ends cleanly and persists partial history", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "privateer-abort-"));
  try {
    const tools = createTools({ cwd, gate: autoApproveGate });
    const engine = new QueryEngine({ routes: routesFor(scriptedModel("z.txt")), system: "s", tools, maxSteps: 10 });
    const ac = new AbortController();
    ac.abort();

    const types: string[] = [];
    for await (const ev of engine.send("go", ac.signal)) types.push(ev.type);

    // It must terminate (no hang) without emitting a normal "finish".
    assert.ok(!types.includes("finish"), `aborted turn should not finish normally, got: ${types.join(",")}`);
    // The user message we pushed is retained for context continuity.
    assert.equal(engine.messages[0].role, "user");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// A model that emits a first chunk then goes silent forever (never emits again,
// never closes) — the shape of a stalled provider/proxy hop. The engine's idle
// watchdog must abort it rather than hang.
function stallingModel() {
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock-1",
    supportedUrls: {},
    async doStream({ abortSignal }: any) {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "thinking" });
            // ...and then nothing — a stall. A real provider tears the stream down
            // when its request is aborted; mirror that so the watchdog's abort
            // actually closes the stream (no leaked pending read).
            abortSignal?.addEventListener("abort", () => {
              try {
                controller.error(new DOMException("Aborted", "AbortError"));
              } catch {
                /* already closed */
              }
            });
          },
        }),
      };
    },
  };
}

test("a stalled stream trips the idle watchdog and yields a retryable error", async () => {
  const engine = new QueryEngine({
    routes: routesFor(stallingModel()),
    system: "s",
    tools: {},
    maxSteps: 3,
    idleTimeoutMs: 60, // tiny so the test doesn't wait
  });

  const events: string[] = [];
  let err: { retryable?: boolean; error: string } | null = null;
  for await (const ev of engine.send("go")) {
    events.push(ev.type);
    if (ev.type === "error") err = { retryable: ev.retryable, error: ev.error };
  }

  assert.ok(err, "should emit an error event on stall");
  assert.equal(err?.retryable, true, "the stall error is retryable");
  assert.match(err!.error, /stopped responding/);
  assert.ok(!events.includes("finish"), "a stalled turn does not finish normally");
  // The user message is retained so a retry keeps context.
  assert.equal(engine.messages[0].role, "user");
});

// A model that streams a chunk every ~15ms forever — never idle, never finishing.
// Only the turn wall-clock cap (not the idle watchdog) can stop it.
function chattyEndlessModel() {
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock-1",
    supportedUrls: {},
    async doStream({ abortSignal }: any) {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t1" });
            const iv = setInterval(() => {
              try {
                controller.enqueue({ type: "text-delta", id: "t1", delta: "tick " });
              } catch {
                clearInterval(iv);
              }
            }, 15);
            abortSignal?.addEventListener("abort", () => {
              clearInterval(iv);
              try {
                controller.error(new DOMException("Aborted", "AbortError"));
              } catch {
                /* already closed */
              }
            });
          },
        }),
      };
    },
  };
}

test("a turn that never converges trips the wall-clock cap with a retryable error", async () => {
  const engine = new QueryEngine({
    routes: routesFor(chattyEndlessModel()),
    system: "s",
    tools: {},
    maxSteps: 3,
    idleTimeoutMs: 10_000, // high — the stream is never idle, so this must NOT fire
    turnTimeoutMs: 120, // low — the wall-clock cap is what stops it
  });

  let err: { retryable?: boolean; error: string } | null = null;
  let sawText = false;
  const types: string[] = [];
  for await (const ev of engine.send("go")) {
    types.push(ev.type);
    if (ev.type === "text") sawText = true;
    if (ev.type === "error") err = { retryable: ev.retryable, error: ev.error };
  }

  assert.ok(sawText, "the turn did stream (so it wasn't idle)");
  assert.ok(err, "should emit an error on the wall-clock cap");
  assert.equal(err?.retryable, true, "the timeout error is retryable");
  assert.match(err!.error, /time limit/);
  assert.ok(!types.includes("finish"), "a capped turn does not finish normally");
});

import { effectiveTokens } from "../src/engine/events.ts";

test("effectiveTokens discounts cache reads and degrades to total without them", () => {
  // No cache hits: collapses to input + output (== raw totalTokens).
  assert.equal(
    effectiveTokens({ inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cachedInputTokens: 0 }),
    1200,
  );

  // OpenRouter convention: inputTokens (prompt_tokens) includes the cached subset.
  // 1000 input, 800 of it cached → 200 full-price + 800*0.1 + 200 out = 480.
  assert.equal(
    effectiveTokens({ inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cachedInputTokens: 800 }),
    480,
  );

  // Anthropic convention: inputTokens counts only fresh tokens, cached reported
  // separately (cached > input). 100 fresh + 900 cached*0.1 + 50 out = 240.
  assert.equal(
    effectiveTokens({ inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 900 }),
    240,
  );
});
