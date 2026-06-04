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
  | { type: "aborted" }
  | { type: "compacted"; before: number; after: number }
  | { type: "finish"; usage: UsageTotals; finishReason: string }
  | { type: "error"; error: string };

export const emptyUsage = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

export function addUsage(a: UsageTotals, b: Partial<UsageTotals>): UsageTotals {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    totalTokens: a.totalTokens + (b.totalTokens ?? 0),
  };
}
