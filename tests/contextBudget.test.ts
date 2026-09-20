import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  CONTEXT_SAFETY_TOKENS,
  MIN_ANSWER_TOKENS,
  clampMaxTokensToContext,
} from "../src/engine/contextBudget.ts";

// The account catalog's flat seed (providers/account.ts seedModel) — the window every
// proxied model is registered with, and the one these numbers are measured against.
const WINDOW = 128_000;
const ASK = 16_384;

test("a full context no longer collapses the answer budget to one token", () => {
  // THE BUG. At the window, stock pi computed max(1, available) and asked the
  // provider for a single token: full prompt sent, full prompt billed, one token
  // back, rendered as "Response was truncated before completion." Every turn after
  // it did the same, which is how a long session stopped resuming.
  for (const used of [WINDOW - CONTEXT_SAFETY_TOKENS, WINDOW, WINDOW + 50_000]) {
    const budget = clampMaxTokensToContext({ contextWindow: WINDOW }, used, ASK);
    assert.equal(budget, MIN_ANSWER_TOKENS, `context of ${used} must still buy a usable answer`);
    assert.ok(budget > 1, "a one-token turn is never a legitimate request");
  }
});

test("the floor never inflates what the caller actually asked for", () => {
  // Compaction's summariser and the turn-prefix summary pass their own small
  // budgets (compaction.js createSummarizationOptions). A floor that raised those
  // would quietly re-spec someone else's request.
  assert.equal(clampMaxTokensToContext({ contextWindow: WINDOW }, 1_000, 64), 64);
  assert.equal(clampMaxTokensToContext({ contextWindow: WINDOW }, WINDOW, 64), 64);
  assert.equal(clampMaxTokensToContext({ contextWindow: WINDOW }, WINDOW, 512), 512);
});

test("a context with room is untouched", () => {
  // The common case must be byte-identical to stock, or this patch is a behaviour
  // change rather than a bug fix.
  assert.equal(clampMaxTokensToContext({ contextWindow: WINDOW }, 0, ASK), ASK);
  assert.equal(clampMaxTokensToContext({ contextWindow: WINDOW }, 50_000, ASK), ASK);
  // Just inside the point where the window starts to bite: available is the answer.
  const used = WINDOW - CONTEXT_SAFETY_TOKENS - 10_000;
  assert.equal(clampMaxTokensToContext({ contextWindow: WINDOW }, used, ASK), 10_000);
});

test("the floor stays inside the safety margin it borrows from", () => {
  // The floor is only safe because 4096 tokens were already held back above it: when
  // `available` lands between 0 and the floor, those tokens were inside that margin
  // all along. If the margin ever drops below the floor this assertion is the alarm.
  assert.ok(MIN_ANSWER_TOKENS < CONTEXT_SAFETY_TOKENS);
  const used = WINDOW - CONTEXT_SAFETY_TOKENS + 1; // available = -1
  const budget = clampMaxTokensToContext({ contextWindow: WINDOW }, used, ASK);
  assert.equal(used + budget <= WINDOW, true, "the floored request must still fit the window");
});

test("an unknown context window passes the ask through", () => {
  // Stock behaviour, deliberately unchanged: with no window we cannot reason about
  // room, so inventing a ceiling would be worse than not clamping.
  assert.equal(clampMaxTokensToContext({ contextWindow: 0 }, 999_999, ASK), ASK);
  assert.equal(clampMaxTokensToContext({ contextWindow: -1 }, 999_999, ASK), ASK);
  // The 1 in that branch guards a zero/negative ask; it is not the floor above.
  assert.equal(clampMaxTokensToContext({ contextWindow: 0 }, 0, 0), 1);
});

test("the shipped patch matches this module", () => {
  // The pi-ai copy is what actually runs. Patching is best-effort by design
  // (bin/apply-patches.mjs), so a drift between the two is silent — pin the
  // constants and the shape of the expression that replaced the `1`. The
  // filename's version suffix moves as pi-ai is upgraded, so find it by prefix
  // rather than pinning a version here too.
  const patchFile = readdirSync("patches").find((f) => f.startsWith("@earendil-works+pi-ai+") && f.endsWith(".patch"));
  assert.ok(patchFile, "no @earendil-works+pi-ai patch found in patches/");
  const patch = readFileSync(`patches/${patchFile}`, "utf8");
  const code = (prefix: string) =>
    patch
      .split("\n")
      .filter((l) => l.startsWith(prefix) && !l.startsWith(prefix.repeat(3)))
      .map((l) => l.slice(1))
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
  const added = code("+");

  assert.match(added, /Math\.min\(maxTokens, Math\.max\(MIN_ANSWER_TOKENS, available\)\)/);
  // The thing being displaced is the old one-token floor.
  assert.match(code("-"), /MIN_MAX_TOKENS/, "the patch must actually displace the stock floor");

  // REGRESSION, caught the hard way: simple-options.js ALREADY exports its own
  // `MIN_ANSWER_TOKENS` (the reserve clampThinkingBudgetToAnswerRoom uses). An
  // earlier draft of this patch declared a second one at the top of the same module,
  // which is a top-level redeclaration — `SyntaxError: Identifier 'MIN_ANSWER_TOKENS'
  // has already been declared` — and the module is on the import path of every
  // provider, so it took the whole CLI down at launch rather than failing quietly.
  // The patch must REFERENCE that constant, never introduce one.
  assert.doesNotMatch(added, /\bconst\s+MIN_ANSWER_TOKENS\b/, "must not redeclare the module's own constant");
});

test("the patched pi-ai module still loads, and clamps the way this module says", async () => {
  // The drift test above reads the patch as text; this one runs what is actually
  // installed. It is the check that would have caught the redeclaration SyntaxError,
  // because a broken simple-options.js fails at import, not at call time.
  const pi: any = await import("@earendil-works/pi-ai/api/simple-options");
  const ctx = (tokens: number) => ({
    systemPrompt: "",
    messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(tokens * 4) }], timestamp: 0 }],
  });
  const live = (used: number, ask = ASK) => pi.clampMaxTokensToContext({ contextWindow: WINDOW }, ctx(used), ask);

  // The bug: a full context used to return 1 from this exact call.
  assert.equal(live(WINDOW), MIN_ANSWER_TOKENS);
  assert.equal(live(WINDOW * 2), MIN_ANSWER_TOKENS);
  // Room to spare is untouched, and a small ask is still honoured.
  assert.equal(live(0), ASK);
  assert.equal(live(WINDOW * 2, 64), 64);

  // And it agrees with the mirror, which is the whole point of keeping one.
  for (const used of [0, 50_000, WINDOW - CONTEXT_SAFETY_TOKENS, WINDOW, WINDOW * 2]) {
    assert.equal(
      live(used),
      clampMaxTokensToContext({ contextWindow: WINDOW }, used, ASK),
      `mirror and patched module disagree at ${used}`,
    );
  }
});
