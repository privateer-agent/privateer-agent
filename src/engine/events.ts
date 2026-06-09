import type { RouteName, Modality } from "./router.ts";

// Normalized events the engine emits while streaming a turn. The UI (and the
// headless print path) consume these without knowing anything about the provider
// or the AI SDK's internal stream-part shapes.

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type EngineEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "tool-result"; id: string; name: string; output: unknown }
  | { type: "tool-error"; id: string; name: string; error: string }
  | { type: "step-finish" }
  | { type: "usage"; usage: UsageTotals } // running total, emitted live as steps finish
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

export const emptyUsage = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

export function addUsage(a: UsageTotals, b: Partial<UsageTotals>): UsageTotals {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    totalTokens: a.totalTokens + (b.totalTokens ?? 0),
  };
}
