import {
  streamText,
  generateText,
  generateObject,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { type EngineEvent, type UsageTotals, emptyUsage, addUsage } from "./events.ts";
import { type RouteSet, selectRoute, requiredModalities } from "./router.ts";
import { redactText } from "../util/redact.ts";
import { describeError, type DescribedError } from "./errors.ts";

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
  // The model routes for this session. `routes.default` is always used unless a
  // turn's data/shape selects a specialized route (see src/engine/router.ts).
  // Per-route flags (cacheControl/thinkingBudget) travel on each Route. Compaction
  // always runs on the default route.
  routes: RouteSet;
  system: string;
  tools: ToolSet;
  maxSteps: number;
  // Approx token budget; when the estimated context exceeds budget*ratio before a
  // turn, older history is summarized away. 0/undefined disables auto-compaction.
  contextBudget?: number;
  compactRatio?: number;
  // Abort a turn and surface a retryable error if the model streams nothing for this
  // long (defaults to IDLE_TIMEOUT_MS). The watchdog is paused during tool execution.
  idleTimeoutMs?: number;
  // Max total wall-clock a single turn may run before it's aborted with a retryable
  // error, streaming or not (NOT paused during tool execution). 0/undefined disables
  // it (defaults to TURN_TIMEOUT_MS, which is 0).
  turnTimeoutMs?: number;
}

// Number of most-recent messages kept verbatim when compacting.
const KEEP_RECENT = 6;

// How many times to auto-retry a turn that failed transiently (rate limit, 5xx,
// network) before any output streamed. Fatal errors (auth/billing/data-policy/bad
// model) are never retried — describeError leaves their `retryable` flag unset.
const MAX_RETRIES = 3;

// Idle-stream watchdog: if the provider streams nothing — no text, reasoning, tool
// delta, or step boundary — for this long, we abort the turn and surface a
// retryable error instead of hanging indefinitely. Reasoning models legitimately
// think for a while, but they still emit reasoning/keep-alive chunks; a truly silent
// gap this long means the connection (or a proxy/TEE hop) stalled. The user's own
// abort (esc) is separate and always honored.
const IDLE_TIMEOUT_MS = 90_000;

// Turn wall-clock cap: total elapsed time a single turn may run before we abort it,
// regardless of whether it's streaming (unlike the idle watchdog, this is NOT paused
// during tool execution — it bounds the whole turn). A backstop against a turn that
// makes steady progress but loops without converging. Disabled by default (0): a
// legitimate large refactor can run many minutes, so this is opt-in per config.
const TURN_TIMEOUT_MS = 0;

// The agent loop. Each `send` streams one user turn through the model, letting the
// AI SDK run the multi-step tool loop internally (executing our tools' execute()),
// while we translate the raw stream into normalized EngineEvents and accumulate usage.
// History persists on the instance so follow-up turns keep context. A turn can be
// interrupted via an AbortSignal; partial output is still persisted to history.
export class QueryEngine {
  readonly messages: ModelMessage[] = [];
  usage: UsageTotals = emptyUsage();

  constructor(private readonly opts: QueryEngineOptions) {}

  // Current context-window occupancy: estimated tokens in history over the budget
  // that triggers compaction. Drives the Claude-Code-style "% of context" readout.
  // `budget` is 0 when auto-compaction is disabled.
  contextUsage(): { used: number; budget: number } {
    return { used: estimateTokens(this.messages), budget: this.opts.contextBudget ?? 0 };
  }

  async *send(
    userText: string,
    signal?: AbortSignal,
    attachments?: { data: string; mediaType: string; modality?: string }[],
  ): AsyncGenerator<EngineEvent, void, void> {
    // Auto-compact before the turn if the context has grown past the budget.
    if (this.shouldCompact()) {
      const res = await this.compact();
      if (res) yield { type: "compacted", before: res.before, after: res.after };
    }

    if (attachments && attachments.length > 0) {
      this.messages.push({
        role: "user",
        content: [
          { type: "text", text: userText },
          // Images go as image parts; documents/audio/video as generic file parts.
          ...attachments.map((a) =>
            a.modality === "image" || a.mediaType.startsWith("image/")
              ? ({ type: "image" as const, image: a.data, mediaType: a.mediaType })
              : ({ type: "file" as const, data: a.data, mediaType: a.mediaType })),
        ],
      });
    } else {
      this.messages.push({ role: "user", content: userText });
    }

    // Pick the model for this turn from its data/shape. Modality requirements are
    // sticky over the whole conversation so attachment history never gets replayed to
    // a model that can't accept it.
    const sel = selectRoute(this.opts.routes, {
      modalities: requiredModalities(this.messages),
      estTokens: estimateTokens(this.messages),
      promptChars: userText.length,
    });
    if (sel.name !== "default" || (sel.missing && sel.missing.length > 0)) {
      yield {
        type: "routed",
        route: sel.name,
        label: sel.route.label,
        reason: sel.reason,
        missing: sel.missing,
      };
    }
    const route = sel.route;

    // Link the caller's abort (esc) to an internal controller we also trip on an
    // idle-stream timeout or a turn wall-clock cap. The `*TimedOut` flags distinguish
    // those from a user abort, so a watchdog abort is reported as a retryable error
    // while a user abort stays a clean stop.
    const turnController = new AbortController();
    let idleTimedOut = false;
    let turnTimedOut = false;
    const onExternalAbort = () => turnController.abort();
    if (signal) {
      if (signal.aborted) turnController.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const idleTimeoutMs = this.opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        turnController.abort();
      }, idleTimeoutMs);
    };
    const disarmIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    // Turn wall-clock cap: armed once at turn start, never reset, fires regardless of
    // streaming activity. Off when turnTimeoutMs <= 0.
    const turnTimeoutMs = this.opts.turnTimeoutMs ?? TURN_TIMEOUT_MS;
    const turnTimer =
      turnTimeoutMs > 0
        ? setTimeout(() => {
            turnTimedOut = true;
            turnController.abort();
          }, turnTimeoutMs)
        : undefined;
    const cleanupWatchdog = () => {
      disarmIdle();
      if (turnTimer) clearTimeout(turnTimer);
      signal?.removeEventListener("abort", onExternalAbort);
    };

    let result;
    try {
      result = streamText({
        model: route.model,
        system: this.opts.system,
        messages: route.cacheControl ? withCacheBreakpoints(this.messages) : this.messages,
        tools: this.opts.tools,
        stopWhen: stepCountIs(this.opts.maxSteps),
        abortSignal: turnController.signal,
        // Re-place the rolling cache breakpoint on every internal tool-loop step.
        // streamText runs the multi-step loop itself, appending tool-call/result
        // messages between API calls; without this the breakpoint stays on the
        // pre-loop tail, so each step's accumulating tool output is re-sent at full
        // price. Marking the new last message each step caches the prefix the
        // previous step already sent. (No-op for non-Anthropic routes.)
        prepareStep: route.cacheControl
          ? ({ messages }) => ({ messages: withCacheBreakpoints(messages) })
          : undefined,
        providerOptions: route.thinkingBudget
          ? { anthropic: { thinking: { type: "enabled", budgetTokens: route.thinkingBudget } } }
          : undefined,
        // streamText's default onError is `console.error(error)`, which dumps the
        // raw error object — request body included, unredacted — over the TUI. The
        // same error reaches us as an `error` part on fullStream (handled below),
        // so the default's only effect is the raw duplicate. Suppress it.
        onError: () => {},
      });
    } catch (err) {
      cleanupWatchdog();
      const d = describeError(err);
      yield { type: "error", error: d.message, hint: d.hint, retryable: d.retryable };
      return;
    }

    // The AI SDK exposes several derived promises that reject lazily when the
    // stream errors. We await some below in their own try/catch, but any we
    // never touch would surface as an unhandled rejection — which Node dumps,
    // unredacted, to the terminal (scrambling the TUI and leaking the request
    // body). Attach no-op catches so a stream error stays inside our channel.
    for (const key of ["text", "steps", "warnings", "sources", "files", "reasoning"] as const) {
      const p = (result as unknown as Record<string, unknown>)[key];
      if (p && typeof (p as Promise<unknown>).then === "function") {
        (p as Promise<unknown>).catch(() => {});
      }
    }

    let assistantText = "";
    let aborted = false;
    // Track usage as steps finish so the UI can tick the token count up live,
    // instead of jumping only when the whole turn ends. `totalUsage` reconciles
    // the authoritative number at finish.
    const baseline = this.usage;
    let stepsUsage = emptyUsage();
    // Mid-step liveness: real usage only arrives at finish-step, so a long single
    // step (e.g. a reasoning model thinking for minutes) would show "0 tokens" the
    // whole time. Estimate output tokens from streamed characters (~4 chars/token)
    // and tick the counter every ~25 estimated tokens; finish-step's authoritative
    // number reconciles. Estimates never touch this.usage.
    let streamedChars = 0;
    let estTokens = 0;
    const estimateTick = (): EngineEvent | null => {
      const est = Math.round(streamedChars / 4);
      if (est - estTokens < 25) return null;
      estTokens = est;
      const turn = addUsage(stepsUsage, {
        inputTokens: 0,
        outputTokens: est,
        totalTokens: est,
        cachedInputTokens: 0,
      });
      return { type: "usage", usage: addUsage(baseline, turn), turn };
    };

    armIdle(); // start the watchdog for the pre-first-chunk window
    try {
      for await (const part of result.fullStream) {
        armIdle(); // any chunk is liveness — reset the idle deadline
        switch (part.type) {
          case "text-delta": {
            if (part.text) {
              assistantText += part.text;
              yield { type: "text", text: part.text };
              streamedChars += part.text.length;
              const tick = estimateTick();
              if (tick) yield tick;
            }
            break;
          }
          case "reasoning-delta": {
            if (part.text) {
              yield { type: "reasoning", text: part.text };
              streamedChars += part.text.length;
              const tick = estimateTick();
              if (tick) yield tick;
            }
            break;
          }
          case "tool-input-delta": {
            // A model streaming a big tool call (e.g. Write with a whole file as
            // args) produces nothing visible until the call completes — count its
            // arg chars so the token ticker shows liveness through it.
            streamedChars += ((part as { delta?: string }).delta ?? "").length;
            const tick = estimateTick();
            if (tick) yield tick;
            break;
          }
          case "tool-call":
            // Pause the watchdog across tool execution: the AI SDK runs the tool's
            // execute() between this part and its tool-result with no intervening
            // stream chunks, and a slow-but-healthy tool (e.g. a 2-min bash) must not
            // read as a stalled model. Tools carry their own timeouts. The next part
            // (tool-result, or the model resuming) re-arms it at the top of the loop.
            disarmIdle();
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
          case "finish-step": {
            const u = (part as { usage?: Partial<UsageTotals> }).usage;
            if (u) {
              // Authoritative usage supersedes the char-based estimate for this
              // step; when a provider omits usage, keep estimating across steps.
              streamedChars = 0;
              estTokens = 0;
              stepsUsage = addUsage(stepsUsage, {
                inputTokens: u.inputTokens ?? 0,
                outputTokens: u.outputTokens ?? 0,
                totalTokens: u.totalTokens ?? 0,
                cachedInputTokens: u.cachedInputTokens ?? 0,
              });
              this.usage = addUsage(baseline, stepsUsage);
              yield { type: "usage", usage: this.usage, turn: stepsUsage };
            }
            yield { type: "step-finish" };
            break;
          }
          case "abort":
            aborted = true;
            break;
          case "error": {
            const d = describeError(part.error);
            yield { type: "error", error: d.message, hint: d.hint, retryable: d.retryable };
            break;
          }
        }
      }
    } catch (err) {
      // Watchdog aborts are checked first: turnController.abort() also makes this look
      // like an abort error, but we want to report it as a retryable timeout, not a
      // clean stop. Persistence below still runs so partial output isn't lost.
      if (idleTimedOut || turnTimedOut) {
        /* reported after persistence */
      } else if (signal?.aborted || isAbortError(err)) {
        aborted = true;
      } else {
        cleanupWatchdog();
        const d = describeError(err);
        yield { type: "error", error: d.message, hint: d.hint, retryable: d.retryable };
        return;
      }
    }
    cleanupWatchdog();

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

    if (idleTimedOut) {
      yield {
        type: "error",
        error: `The model stopped responding — no output for ${Math.round(idleTimeoutMs / 1000)}s.`,
        hint: "The provider or proxy may have stalled. Send the message again to retry, or switch models with /model.",
        retryable: true,
      };
      return;
    }

    if (turnTimedOut) {
      yield {
        type: "error",
        error: `The turn hit its ${Math.round(turnTimeoutMs / 1000)}s time limit and was stopped.`,
        hint: "Raise `turnTimeoutMs` in config (or set it to 0 to disable), or narrow the request. Send a follow-up to continue from here.",
        retryable: true,
      };
      return;
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
      cachedInputTokens: turnUsage.cachedInputTokens ?? 0,
    };
    // Reconcile against the authoritative turn total. We already folded per-step
    // usage into this.usage live; rebase on the baseline so we don't double-count.
    // Fall back to the accumulated step usage if the provider omitted totalUsage.
    this.usage = addUsage(baseline, usage.totalTokens > 0 ? usage : stepsUsage);

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
        model: this.opts.routes.default.model,
        schema: CompactionSchema,
        prompt: instruction,
      });
      summary = formatCompaction(object);
    } catch {
      // Some models/providers handle structured output poorly — fall back to text.
      try {
        const { text } = await generateText({ model: this.opts.routes.default.model, prompt: instruction });
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
  return redactText(rawErrMsg(err));
}

function rawErrMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
