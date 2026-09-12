// How many output tokens a turn may ask for, once the prompt has taken its share.
//
// Mirrors the patched clampMaxTokensToContext in pi-ai (api/simple-options.js) —
// that copy is what actually runs; this one is where the behaviour is specified and
// tested. See patches/@earendil-works+pi-ai+0.84.4.patch.
//
// ── The bug this exists to fix ───────────────────────────────────────────────
//
// Stock pi computes the answer budget as
//
//     available = contextWindow − estimateContextTokens(context) − 4096
//     maxTokens = min(asked, max(1, available))
//
// and that floor is literally `1`. So the moment the estimate reaches the declared
// window, every turn asks the provider for ONE token. The request still goes out,
// still sends the whole prompt, and is still billed in full — and comes back with a
// single token and `finish_reason: "length"`, which the TUI renders as "Response was
// truncated before completion." Compaction runs once, and if the estimate is still
// over (it usually is — see below) the session is stuck there: every turn burns a
// full-price prompt to produce nothing. That is the "it won't resume" failure, and
// it is reachable on any long session.
//
// Two things conspire to reach it early. `estimateContextTokens` is a chars/4
// approximation over the whole context — system prompt and tool schemas included —
// so it runs ahead of what the provider actually counts; and Privateer registers
// every account model with a flat `contextWindow: 128000` (providers/account.ts
// seedModel) because /api/models does not publish per-model windows. A model with a
// larger real window therefore hits this ceiling while it still has room.
//
// ── The fix ──────────────────────────────────────────────────────────────────
//
// Floor the budget at a usable answer instead of at 1. The floor only ever raises
// `available`; it never raises what the caller asked for, so a deliberately small
// request (a summariser, a title) keeps its own number — the `min` still wins.
//
// It is safe against the window because the floor is smaller than the 4096-token
// safety margin already subtracted above: when `available` lands between 0 and the
// floor, the tokens we hand back were inside that margin all along.
//
// When `available` is genuinely negative the context really does not fit, and the
// honest outcome is the provider saying so — a context-length error, which pi
// classifies via isContextOverflow and answers with compaction, the path designed
// for exactly this. That is strictly better than the silent one-token stub it
// replaces: same cost, but the agent recovers instead of looking hung.
export const CONTEXT_SAFETY_TOKENS = 4096;

// pi-ai's own MIN_ANSWER_TOKENS — the floor it already reserves when a thinking
// budget shares the response ceiling (clampThinkingBudgetToAnswerRoom). Below this a
// turn cannot produce a usable answer or even a complete tool call, so asking for
// less is never worth a request.
//
// The patch REFERENCES that constant rather than declaring its own: simple-options.js
// exports it from the same module scope, so a second top-level `const` of that name
// is a SyntaxError — and since every provider imports this module, that one would not
// fail quietly, it would stop the CLI from starting. This copy exists so the value is
// stated and tested here; tests/contextBudget.test.ts pins both halves together.
export const MIN_ANSWER_TOKENS = 1024;

export interface ContextBudgetModel {
  contextWindow: number;
}

export function clampMaxTokensToContext(
  model: ContextBudgetModel,
  estimatedContextTokens: number,
  maxTokens: number,
): number {
  // An unknown window (0 or absent) means "we cannot reason about room" — pass the
  // ask through rather than inventing a ceiling. Stock behaviour, kept verbatim:
  // the 1 here guards a zero/negative ask, it is not the floor this patch changes.
  if (!(model.contextWindow > 0)) return Math.max(1, maxTokens);
  const available = model.contextWindow - estimatedContextTokens - CONTEXT_SAFETY_TOKENS;
  return Math.min(maxTokens, Math.max(MIN_ANSWER_TOKENS, available));
}
