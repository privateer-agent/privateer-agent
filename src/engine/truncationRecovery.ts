// What to do when a run ends on a reply the model never finished.
//
// A provider that stops a reply with `finish_reason: "length"` hit the turn's output
// cap. The TUI renders it as "Response was truncated before completion." and pi then
// does one of two things:
//
//   - output ended BELOW the model's maxTokens: pi reads it as context pressure and
//     compacts and retries the turn once (agent-session _checkCompaction,
//     isRecoverableLength). That case is pi's, and this module stays out of it.
//   - output used the WHOLE budget: pi treats it as final and the run just ends. The
//     agent stops mid-task with nothing to resume it but the user typing "continue".
//
// The second case is what real sessions hit, and nearly always the same way: a
// thinking model spends the entire budget reasoning (measured: z-ai/glm-5.3-flash,
// 16384 of 16384 output tokens, 45–67k characters of reasoning, no text and no tool
// call — nine times across one user's logs). Raising maxTokens to the model's real cap
// (providers/account.ts) makes that rarer; this makes it recoverable when it happens.
//
// So: when a run ends on a full-budget length stop, queue one follow-up asking the
// model to pick up where it was cut off, and keep its reasoning short. Pi continues a
// message queued from an agent_end handler inside the same run (_handlePostAgentRun →
// hasQueuedMessages), so headless `-p` runs wait for it too.
//
// Bounded: at most MAX_AUTO_CONTINUES in a row. A model that truncates every time
// would otherwise loop forever, billing a full budget per lap. Any reply that ends
// some other way resets the count.
//
// IMPORT-SAFETY: no Pi imports — the shapes below are the few fields read.

export const MAX_AUTO_CONTINUES = 2;

export interface TruncationAssistant {
  role?: string;
  stopReason?: string;
  usage?: { output?: number };
  content?: { type?: string }[];
}

export type TruncationDecision =
  | { action: "none" }
  | { action: "continue"; attempt: number; prompt: string }
  | { action: "give-up" };

export function lastAssistant(messages: unknown): TruncationAssistant | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as TruncationAssistant | undefined;
    if (m?.role === "assistant") return m;
  }
  return undefined;
}

/**
 * Whether a length stop used the model's whole output budget. Mirrors the negation of
 * pi-ai's isRecoverableLength: below the budget is pi's compact-and-retry, at it is
 * ours. An unknown budget (0) means we cannot tell, so we leave it alone.
 */
export function isFullBudgetLengthStop(message: TruncationAssistant | undefined, modelMaxTokens: number): boolean {
  if (message?.stopReason !== "length") return false;
  if (!(modelMaxTokens > 0)) return false;
  const output = message.usage?.output;
  return typeof output === "number" && output >= modelMaxTokens;
}

/**
 * The follow-up text. Says what happened in terms the model can act on: a cut-off
 * spent on reasoning needs a terser plan, a cut-off mid-tool-call needs the call
 * re-issued (its arguments were incomplete and never ran).
 */
export function continuationPrompt(message: TruncationAssistant): string {
  const kinds = new Set((message.content ?? []).map((c) => c?.type));
  const base = "Your previous reply hit the output limit and was cut off before it finished.";
  if (kinds.has("toolCall")) {
    return `${base} The tool call at the end was incomplete and did not run — issue it again in full. Keep any reasoning brief.`;
  }
  if (!kinds.has("text")) {
    return `${base} It was spent entirely on reasoning. Don't restate it: keep thinking short and go straight to the next tool call or your answer.`;
  }
  return `${base} Continue exactly where you left off, without repeating what you already wrote. Keep any reasoning brief.`;
}

export function decideTruncationRecovery(
  messages: unknown,
  modelMaxTokens: number,
  consecutive: number,
): TruncationDecision {
  const last = lastAssistant(messages);
  if (!isFullBudgetLengthStop(last, modelMaxTokens)) return { action: "none" };
  if (consecutive >= MAX_AUTO_CONTINUES) return { action: "give-up" };
  return { action: "continue", attempt: consecutive + 1, prompt: continuationPrompt(last!) };
}
