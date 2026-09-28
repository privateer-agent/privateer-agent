import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSystemPrompt } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js"; // not in the package exports
import privateerIdentity, { IDENTITY_MARKER, applyIdentity } from "../src/identity.ts";
import privateerContext from "../extensions/privateer-context.ts";

/**
 * The model used to believe it ran inside `pi` and reached for `pi -p` — a bare Pi run
 * with no permission gate, no spend caps and no privacy routing. These pin that the
 * prompt it actually gets names Privateer and its gated CLI.
 */

// The real prompt Pi builds, so a Pi upgrade that rewords its preamble fails here
// rather than silently leaving the model thinking it is `pi` again.
function piPrompt(): string {
  return buildSystemPrompt({ cwd: "/tmp", selectedTools: ["read", "bash"] });
}

test("identity: Pi's self-description is replaced with Privateer's", () => {
  const out = applyIdentity(piPrompt(), "privateer");
  assert.ok(!out.includes("operating inside pi,"), "the model must not be told it runs pi");
  assert.ok(out.includes("operating inside Privateer"));
  assert.ok(!out.includes("asks about pi itself"), "Pi's docs are relabelled as SDK docs");
});

test("identity: the gated one-shot CLI is spelled out, and bare pi forbidden", () => {
  const out = applyIdentity(piPrompt(), "privateer");
  for (const s of ["privateer -p", "--allow-spend", "--max-calls", "--approve-in-app", "privateer acp", "never run `pi`"]) {
    assert.ok(out.includes(s), `prompt must mention ${s}`);
  }
});

test("identity: uses the command the user actually invoked", () => {
  assert.ok(applyIdentity("BASE", "pvt").includes("`pvt -p"));
});

test("identity: append-only and idempotent", () => {
  const once = applyIdentity("BASE");
  assert.ok(once.startsWith("BASE"));
  assert.equal(applyIdentity(once), once);
  assert.equal(once.split(IDENTITY_MARKER).length - 1, 1);
});

test("identity: the extension leaves a missing prompt alone", () => {
  let handler: any;
  privateerIdentity({ on: (_n: string, fn: any) => (handler = fn) });
  assert.equal(handler({}), undefined);
  assert.equal(handler(undefined), undefined);
  assert.ok(handler({ systemPrompt: "BASE" }).systemPrompt.includes(IDENTITY_MARKER));
});

test("identity: the discovered context shim carries it (TUI, -p, subagents)", () => {
  const handlers: any[] = [];
  privateerContext({
    on: (name: string, fn: any) => name === "before_agent_start" && handlers.push(fn),
    registerCommand: () => {},
  } as any);
  let prompt = "BASE";
  for (const h of handlers) prompt = h({ systemPrompt: prompt, systemPromptOptions: { cwd: "/" } })?.systemPrompt ?? prompt;
  assert.ok(prompt.includes(IDENTITY_MARKER));
});
