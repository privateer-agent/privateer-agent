import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import privateerContext from "../extensions/privateer-context.ts";
import { CONTEXT_BLOCK_MARKER, RUNTIME_GUIDELINES_MARKER } from "../src/context.ts";

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
