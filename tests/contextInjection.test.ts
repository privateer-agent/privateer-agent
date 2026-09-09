import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import privateerContext from "../extensions/privateer-context.ts";
import {
  CONTEXT_BLOCK_MARKER,
  CONTEXT_MAX_BYTES_ENV,
  DEFAULT_CONTEXT_MAX_BYTES,
  RUNTIME_GUIDELINES_MARKER,
  contextBlock,
  contextMaxBytes,
  contextStats,
  runtimeGuidelinesBlock,
} from "../src/context.ts";

/**
 * What extensions/privateer-context.ts is allowed to do to a system prompt.
 *
 * This handler is the only one in the moat that REWRITES the system prompt, and it runs
 * on the desktop and nowhere else (`context: true` is set for `kind: "desktop"` alone —
 * src/config/moat.ts). Pi chains before_agent_start handlers and treats a returned
 * `systemPrompt` as a REPLACEMENT for what the chain has built, so the failure mode of
 * getting this wrong is not a missing PRIVATEER.md — it is a turn that goes out with the
 * agent's entire system prompt replaced by two paragraphs about ripgrep, silently, on the
 * one surface most users are on.
 *
 * 0.12.29 moved the handler to an unconditional `return { systemPrompt }` built from
 * `event?.systemPrompt ?? ""`, which is exactly that bug on any host that doesn't
 * populate the field. Every assertion below is one half of "append, or say nothing".
 */

// Drive the extension the way Pi does: register the handler, then hand it an event.
function handlerFor(): (event: unknown) => { systemPrompt?: string } | undefined {
  let handler: ((event: unknown) => any) | undefined;
  const pi = {
    on: (name: string, fn: (event: unknown) => any) => {
      if (name === "before_agent_start") handler = fn;
    },
    registerCommand: () => {},
  };
  privateerContext(pi as any);
  assert.ok(handler, "the extension must register a before_agent_start handler");
  return handler!;
}

// A directory with no PRIVATEER.md anywhere above it, so contextBlock() returns "".
// Under the OS temp root, which has no Privateer checkout in its ancestry.
function emptyCwd(): { cwd: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "privateer-ctx-"));
  const cwd = join(dir, "nested");
  mkdirSync(cwd);
  return { cwd, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("context: the host's prompt survives — our blocks are APPENDED, never substituted", () => {
  const { cwd, cleanup } = emptyCwd();
  try {
    const base = "SYSTEM PROMPT THE HOST BUILT";
    const out = handlerFor()({ systemPrompt: base, systemPromptOptions: { cwd } });
    assert.ok(out?.systemPrompt, "a prompt with something to add comes back rewritten");
    assert.ok(
      out!.systemPrompt!.startsWith(base),
      "the host's prompt must still be the head of what we hand back",
    );
    assert.ok(out!.systemPrompt!.includes(RUNTIME_GUIDELINES_MARKER), "guidelines injected");
  } finally {
    cleanup();
  }
});

test("context: PRIVATEER.md is appended after the host's prompt when one is found", () => {
  const { cwd, cleanup } = emptyCwd();
  try {
    writeFileSync(join(cwd, "PRIVATEER.md"), "house rules for this project");
    const base = "SYSTEM PROMPT THE HOST BUILT";
    const out = handlerFor()({ systemPrompt: base, systemPromptOptions: { cwd } });
    const prompt = out?.systemPrompt ?? "";
    assert.ok(prompt.startsWith(base), "the host's prompt stays at the head");
    assert.ok(prompt.includes(CONTEXT_BLOCK_MARKER), "the PRIVATEER.md block is present");
    assert.ok(prompt.includes("house rules for this project"), "…with the file's contents");
  } finally {
    cleanup();
  }
});

test("context: no systemPrompt field → inject NOTHING, never a prompt built from ''", () => {
  const { cwd, cleanup } = emptyCwd();
  try {
    const handler = handlerFor();
    // The regression this file exists for. A host that hands us no prompt gets no
    // rewrite: returning one synthesised from "" would BE the whole system prompt.
    for (const event of [
      { systemPromptOptions: { cwd } },
      { systemPrompt: undefined, systemPromptOptions: { cwd } },
      { systemPrompt: null, systemPromptOptions: { cwd } },
      {},
      undefined,
    ]) {
      assert.equal(
        handler(event),
        undefined,
        `no usable systemPrompt must produce no rewrite (${JSON.stringify(event)})`,
      );
    }
  } finally {
    cleanup();
  }
});

test("context: a re-entrant chain adds nothing a second time", () => {
  const { cwd, cleanup } = emptyCwd();
  try {
    const handler = handlerFor();
    const first = handler({ systemPrompt: "BASE", systemPromptOptions: { cwd } });
    const once = first?.systemPrompt ?? "";
    assert.ok(once.includes(RUNTIME_GUIDELINES_MARKER));

    // Same prompt back through the chain: both markers are already there, so there is
    // nothing to contribute and the handler must leave the chain alone rather than
    // returning a duplicate-free-but-still-substituted copy.
    const second = handler({ systemPrompt: once, systemPromptOptions: { cwd } });
    assert.equal(second, undefined, "a second pass adds nothing and returns nothing");

    // And the guidelines are not stacked when the chain does rewrite for another reason.
    const occurrences = once.split(RUNTIME_GUIDELINES_MARKER).length - 1;
    assert.equal(occurrences, 1, "the guidelines block appears exactly once");
  } finally {
    cleanup();
  }
});

test("context: -nc / --no-context-files silences EVERYTHING this extension injects", () => {
  // CONTEXT_FILES_DISABLED is read once at module scope from process.argv, so the flag
  // cannot be flipped inside a live import — a behavioural check would need a child
  // process per flag for one branch. Pin the ordering in the source instead, which is
  // the property that actually has to hold: the disable gate comes FIRST, so the
  // guidelines block sits behind it rather than in front. 0.12.29 moved the guidelines
  // ahead of the gate, which is how -nc came to half-work.
  const src = readFileSync(
    join(import.meta.dirname, "..", "extensions", "privateer-context.ts"),
    "utf8",
  );
  const gate = src.indexOf("if (CONTEXT_FILES_DISABLED) return;");
  assert.ok(gate > 0, "the handler still opens with the disable gate");
  for (const injected of ["runtimeGuidelinesBlock()", "contextBlock(cwd)"]) {
    assert.ok(
      src.indexOf(injected, gate) > gate,
      `${injected} must sit behind the -nc gate, or the flag half-works`,
    );
  }
});

/**
 * The per-turn budget (src/context.ts).
 *
 * A context file is charged inside the system prompt of EVERY request, so its size is a
 * tax on every tool call, not a one-off load. Measured case that put this cap here: a
 * 117 KB PRIVATEER.md in a game project sent ~34,000 tokens per request, on confidential
 * endpoints that have no prompt cache to read them back from — 121 tool calls in one turn,
 * 17 minutes, nearly all of it time-to-first-token.
 *
 * What has to hold: a normal file is loaded verbatim (the cap must never become a silent
 * editor of small files), an oversized one is cut at a line boundary and SAYS SO in the
 * block itself, and the user can always turn the cap off.
 */

function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env[CONTEXT_MAX_BYTES_ENV];
  if (value === undefined) delete process.env[CONTEXT_MAX_BYTES_ENV];
  else process.env[CONTEXT_MAX_BYTES_ENV] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[CONTEXT_MAX_BYTES_ENV];
    else process.env[CONTEXT_MAX_BYTES_ENV] = prev;
  }
}

test("budget: a file inside the cap is injected byte-for-byte", () => {
  const { cwd, cleanup } = emptyCwd();
  try {
    const body = "## Conventions\n" + "small enough to load whole\n".repeat(20);
    writeFileSync(join(cwd, "PRIVATEER.md"), body);
    const stats = contextStats(cwd);
    assert.equal(stats.truncated, false);
    assert.equal(stats.files[0].loaded, body, "no cut, no footer, no rewriting");
    assert.equal(stats.loadedBytes, stats.diskBytes);
    assert.ok(contextBlock(cwd).includes(body));
  } finally {
    cleanup();
  }
});

test("budget: an oversized file is cut, and the block says where the rest is", () => {
  const { cwd, cleanup } = emptyCwd();
  try {
    const path = join(cwd, "PRIVATEER.md");
    const head = "# Project\nthe part that matters\n";
    writeFileSync(path, head + "history line\n".repeat(20_000)); // ~250 KB
    const stats = contextStats(cwd);
    const file = stats.files[0];

    assert.equal(file.truncated, true);
    assert.ok(file.loadedBytes <= DEFAULT_CONTEXT_MAX_BYTES, "cut to the budget");
    assert.ok(file.bytes > DEFAULT_CONTEXT_MAX_BYTES * 4, "the fixture really is oversized");
    assert.ok(file.loaded.startsWith(head), "the HEAD is kept — a context file opens with what the project is");
    assert.ok(file.loaded.includes(path), "the model is told which file to read for the rest");
    assert.ok(/every turn/i.test(file.loaded), "…and why it was cut");
    assert.ok(
      file.loaded.slice(0, file.loadedBytes).endsWith("\n") ||
        file.loaded.slice(0, file.loadedBytes).endsWith("history line"),
      "the cut lands on a line boundary",
    );

    // The whole point: what reaches the model is bounded, not the file size.
    const block = contextBlock(cwd);
    assert.ok(Buffer.byteLength(block, "utf-8") < file.bytes / 2);
  } finally {
    cleanup();
  }
});

test("budget: the cap is overridable, and 'off' loads the file whole", () => {
  const { cwd, cleanup } = emptyCwd();
  try {
    const body = "x".repeat(80 * 1024);
    writeFileSync(join(cwd, "PRIVATEER.md"), body);

    withEnv("off", () => {
      const stats = contextStats(cwd);
      assert.equal(stats.truncated, false, "opting out means opting out");
      assert.equal(stats.files[0].loaded, body);
      assert.equal(stats.maxBytes, Number.POSITIVE_INFINITY);
    });

    withEnv("4096", () => {
      const stats = contextStats(cwd);
      assert.equal(stats.maxBytes, 4096);
      assert.ok(stats.files[0].loadedBytes <= 4096);
    });

    // A typo must not amputate the file to nothing — fall back to the default.
    withEnv("banana", () => {
      assert.equal(contextMaxBytes(), DEFAULT_CONTEXT_MAX_BYTES);
    });
  } finally {
    cleanup();
  }
});

test("guidelines: the shell-state and batching rules are in every turn", () => {
  // These two lines exist to stop the two behaviours that made turns slow: a `cd` per
  // tool call (shell state does not survive a call) and 60-120 one-line calls in a row
  // (each one re-sends the whole conversation).
  const block = runtimeGuidelinesBlock();
  assert.match(block, /fresh subshell/i);
  assert.match(block, /never spend a call on `cd` alone/i);
  assert.match(block, /re-sends the whole conversation/i);
});
