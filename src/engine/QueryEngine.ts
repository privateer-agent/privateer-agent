import {
  streamText,
  generateText,
  generateObject,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
  type LanguageModel,
} from "ai";
import { z } from "zod";
import { type EngineEvent, type UsageTotals, emptyUsage, addUsage } from "./events.ts";

// Structured shape for compaction so the summary preserves the parts that matter for
// continuing the work, rather than a free-form blob.
const CompactionSchema = z.object({
  goals: z.string().describe("The user's overall goals for this session."),
  decisions: z.array(z.string()).describe("Key decisions, approaches, and findings so far."),
  filesTouched: z.array(z.string()).describe("File paths created or modified, each with a short note."),
  openThreads: z.array(z.string()).describe("Unfinished tasks, next steps, and open questions."),
});

export function formatCompaction(o: z.infer<typeof CompactionSchema>): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");
  return [
    `Goals: ${o.goals}`,
    `Decisions:\n${list(o.decisions)}`,
    `Files touched:\n${list(o.filesTouched)}`,
    `Open threads:\n${list(o.openThreads)}`,
  ].join("\n\n");
}

export interface QueryEngineOptions {
  model: LanguageModel;
  system: string;
  tools: ToolSet;
  maxSteps: number;
  // When true, attach Anthropic ephemeral cache breakpoints so the static prefix
  // (system + tool schemas + history) is cached. No-op for non-Anthropic providers.
  cacheControl?: boolean;
  // Approx token budget; when the estimated context exceeds budget*ratio before a
  // turn, older history is summarized away. 0/undefined disables auto-compaction.
  contextBudget?: number;
  compactRatio?: number;
  // Anthropic extended-thinking budget in tokens. Only applied for Anthropic-family
  // models (set by the session); ignored elsewhere.
  thinkingBudget?: number;
}

// Number of most-recent messages kept verbatim when compacting.
const KEEP_RECENT = 6;

// The agent loop. Each `send` streams one user turn through the model, letting the
// AI SDK run the multi-step tool loop internally (executing our tools' execute()),
// while we translate the raw stream into normalized EngineEvents and accumulate usage.
// History persists on the instance so follow-up turns keep context. A turn can be
// interrupted via an AbortSignal; partial output is still persisted to history.
export class QueryEngine {
  readonly messages: ModelMessage[] = [];
  usage: UsageTotals = emptyUsage();

  constructor(private readonly opts: QueryEngineOptions) {}

  async *send(
    userText: string,
    signal?: AbortSignal,
    images?: { data: string; mediaType: string }[],
  ): AsyncGenerator<EngineEvent, void, void> {
    // Auto-compact before the turn if the context has grown past the budget.
    if (this.shouldCompact()) {
      const res = await this.compact();
      if (res) yield { type: "compacted", before: res.before, after: res.after };
    }

    if (images && images.length > 0) {
      this.messages.push({
        role: "user",
        content: [
          { type: "text", text: userText },
          ...images.map((im) => ({ type: "image" as const, image: im.data, mediaType: im.mediaType })),
        ],
      });
    } else {
      this.messages.push({ role: "user", content: userText });
    }

    let result;
    try {
      result = streamText({
        model: this.opts.model,
        system: this.opts.system,
        messages: this.opts.cacheControl ? withCacheBreakpoints(this.messages) : this.messages,
        tools: this.opts.tools,
        stopWhen: stepCountIs(this.opts.maxSteps),
        abortSignal: signal,
        providerOptions: this.opts.thinkingBudget
          ? { anthropic: { thinking: { type: "enabled", budgetTokens: this.opts.thinkingBudget } } }
          : undefined,
      });
    } catch (err) {
      yield { type: "error", error: errMsg(err) };
      return;
    }

    let assistantText = "";
    let aborted = false;

    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            if (part.text) {
              assistantText += part.text;
              yield { type: "text", text: part.text };
            }
            break;
          case "reasoning-delta":
            if (part.text) yield { type: "reasoning", text: part.text };
            break;
          case "tool-call":
            yield { type: "tool-call", id: part.toolCallId, name: part.toolName, input: part.input };
            break;
          case "tool-result":
            yield {
              type: "tool-result",
              id: part.toolCallId,
              name: part.toolName,
              output: (part as { output: unknown }).output,
            };
            break;
          case "tool-error":
            yield {
              type: "tool-error",
              id: part.toolCallId,
              name: part.toolName,
              error: errMsg((part as { error: unknown }).error),
            };
            break;
          case "finish-step":
            yield { type: "step-finish" };
            break;
          case "abort":
            aborted = true;
            break;
          case "error":
            yield { type: "error", error: errMsg(part.error) };
            break;
        }
      }
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) {
        aborted = true;
      } else {
        yield { type: "error", error: errMsg(err) };
        return;
      }
    }

    // Persist the model's response so the next turn keeps context. On a clean finish
    // we use the SDK's structured messages; on an interrupt those may be unavailable,
    // so we fall back to a synthetic assistant message from the text we streamed.
    let persisted = false;
    try {
      const response = await result.response;
      if (response?.messages?.length) {
        this.messages.push(...response.messages);
        persisted = true;
      }
    } catch {
      /* aborted/errored before a response was assembled */
    }
    if (!persisted && assistantText.trim()) {
      this.messages.push({ role: "assistant", content: assistantText });
    }

    if (aborted) {
      yield { type: "aborted" };
      return;
    }

    const turnUsage = await result.totalUsage.catch(() => ({}) as Record<string, number>);
    const usage: UsageTotals = {
      inputTokens: turnUsage.inputTokens ?? 0,
      outputTokens: turnUsage.outputTokens ?? 0,
      totalTokens: turnUsage.totalTokens ?? 0,
    };
    this.usage = addUsage(this.usage, usage);

    const finishReason = await result.finishReason.catch(() => "unknown");
    yield { type: "finish", usage, finishReason };
  }

  private shouldCompact(): boolean {
    const budget = this.opts.contextBudget;
    if (!budget) return false;
    const ratio = this.opts.compactRatio ?? 0.8;
    return this.messages.length > KEEP_RECENT && estimateTokens(this.messages) > budget * ratio;
  }

  // Summarize older history into a single briefing message, keeping the most recent
  // messages verbatim. Uses a schema-guided summary (goals / decisions / files /
  // open threads) so the structure survives, falling back to a plain-text summary if
  // structured output fails. The cut always lands on a `user` message so tool-call /
  // result pairs are never orphaned. Returns before/after token estimates, or null
  // when there's nothing worth compacting. Best-effort: failures leave history intact.
  async compact(): Promise<{ before: number; after: number } | null> {
    const before = estimateTokens(this.messages);
    const cut = safeCutIndex(this.messages, KEEP_RECENT);
    if (cut <= 0) return null;

    const older = this.messages.slice(0, cut);
    const recent = this.messages.slice(cut);
    const transcript = older.map((m) => `${m.role}: ${renderContent(m.content)}`).join("\n\n");
    const instruction =
      `Summarize the earlier part of this coding session so the work can continue without the ` +
      `full history. Be specific and terse.\n\n---\n${transcript}`;

    let summary: string;
    try {
      const { object } = await generateObject({
        model: this.opts.model,
        schema: CompactionSchema,
        prompt: instruction,
      });
      summary = formatCompaction(object);
    } catch {
      // Some models/providers handle structured output poorly — fall back to text.
      try {
        const { text } = await generateText({ model: this.opts.model, prompt: instruction });
        summary = text.trim();
      } catch {
        return null; // leave history untouched on failure
      }
    }
    if (!summary) return null;

    this.messages.length = 0;
    this.messages.push({ role: "user", content: `[Summary of earlier conversation]\n${summary}` });
    this.messages.push(...recent);

    return { before, after: estimateTokens(this.messages) };
  }
}

// Cheap heuristic token estimate (~4 chars/token) over serialized message content.
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += renderContent(m.content).length + m.role.length;
  return Math.ceil(chars / 4);
}

// Choose a cut so the kept tail starts on a `user` message — never orphaning a tool
// result from its tool-call. Returns 0 when there's nothing safe to drop.
function safeCutIndex(messages: ModelMessage[], minKeep: number): number {
  let cut = messages.length - minKeep;
  if (cut <= 0) return 0;
  while (cut < messages.length && messages[cut].role !== "user") cut++;
  return cut >= messages.length ? 0 : cut;
}

function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const part = p as { type?: string; text?: string; toolName?: string };
        if (part.type === "text" && part.text) return part.text;
        if (part.type === "tool-call") return `[tool-call ${part.toolName ?? ""}]`;
        if (part.type === "tool-result") return `[tool-result ${part.toolName ?? ""}]`;
        return `[${part.type ?? "part"}]`;
      })
      .join(" ");
  }
  return "";
}

// Attach Anthropic ephemeral cache breakpoints. Anthropic caches the longest prefix
// ending at a breakpoint, so we mark the first message (stable base: system + tools +
// first turn) and the last message (rolling: grows with the conversation). Returns a
// shallow copy so the stored history stays free of provider-specific annotations.
const CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

function withCacheBreakpoints(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  markBreakpoint(out, 0);
  if (out.length > 1) markBreakpoint(out, out.length - 1);
  return out;
}

function markBreakpoint(messages: ModelMessage[], i: number): void {
  const msg = messages[i] as { role: string; content: unknown };
  const parts =
    typeof msg.content === "string"
      ? [{ type: "text", text: msg.content }]
      : (msg.content as unknown[]).slice();
  if (parts.length === 0) return;
  const last = parts.length - 1;
  parts[last] = { ...(parts[last] as object), providerOptions: CACHE };
  messages[i] = { ...msg, content: parts } as unknown as ModelMessage;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
