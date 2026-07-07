import type { RouteName, Modality } from "./router.ts";

// Normalized events the engine emits while streaming a turn. The UI (and the
// headless print path) consume these without knowing anything about the provider
// or the AI SDK's internal stream-part shapes.

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  // Cache-read input tokens (a subset of input, billed at a fraction of the base
  // rate). Providers differ on whether `inputTokens` already includes these — see
  // `effectiveTokens`, which handles both conventions.
  cachedInputTokens: number;
}

export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name: string; output: unknown }
  | { type: "tool-error"; id: string; name: string; error: string }
  | { type: "step-finish" }
  // `usage` is the cumulative session total; `turn` is just this turn's accumulation
  // so far. Both emitted live as steps finish so the UI can show either.
  | { type: "usage"; usage: UsageTotals; turn: UsageTotals }
  | { type: "aborted" }
  | { type: "compacted"; before: number; after: number }
  // The router switched this turn to a non-default model. `missing` lists modalities
  // the chosen model can't accept (set when no configured model fully covers the turn).
  | { type: "routed"; route: RouteName; label: string; reason?: string; missing?: Modality[] }
  | { type: "finish"; usage: UsageTotals; finishReason: string }
  // A transient failure (rate limit, 5xx, network) is being retried automatically
  // before any output streamed. `attempt`/`max` are 1-based for display; `reason` is
  // the redacted error message that triggered the retry.
  | { type: "retrying"; attempt: number; max: number; delayMs: number; reason: string }
  // `error` is the short user-facing message; `hint` is an optional actionable
  // next step rendered dim beneath it. Both are already secret-redacted.
  | { type: "error"; error: string; hint?: string; retryable?: boolean };

export const emptyUsage = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
});

export function addUsage(a: UsageTotals, b: Partial<UsageTotals>): UsageTotals {
  return {
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  };
}

// Anthropic bills a cache read at ~10% of the base input rate. Re-price the cached
// portion at that rate to estimate what was actually billed, rather than the raw
// `totalTokens` which counts every re-sent cached token at full weight.
const CACHE_READ_RATE = 0.1;

// Effective (billed-weighted) token estimate. Providers disagree on whether
// `inputTokens` already includes `cachedInputTokens`: OpenRouter's `prompt_tokens`
// includes them (cached ≤ input), Anthropic's `input_tokens` counts only fresh
// tokens (cached reported separately, so cached may exceed input). We detect which
// convention applies and discount the cached portion either way. With no cache
// hits this collapses to `inputTokens + outputTokens` (== totalTokens).
export function effectiveTokens(u: UsageTotals): number {
  const cached = u.cachedInputTokens ?? 0;
  const input = u.inputTokens ?? 0;
  const inputIncludesCached = cached <= input;
  const fullPriceInput = inputIncludesCached ? input - cached : input;
  return Math.round(fullPriceInput + cached * CACHE_READ_RATE + (u.outputTokens ?? 0));
}
