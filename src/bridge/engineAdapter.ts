// The load-bearing bridge: translate Pi's session.subscribe() events into the
// privateer `EngineEvent` vocabulary that RelayClient.sendEvent() already speaks.
// This is the ENTIRE coupling between Pi and the preserved connection layer — the
// relay/app see EngineEvents and never learn the loop underneath changed.
//
// Promoted from ../../ pi-spike/adapter.mjs (spike-B proven) and HARDENED per
// Phase 1 of docs/pi-migration-plan.md:
//   - stateful so `usage` carries BOTH the cumulative session total and this
//     turn's delta (the real EngineEvent shape, unlike the stateless spike),
//   - `finish` carries usage + finishReason,
//   - compaction / auto-retry / agent-end-error mapped through.
//
// Pi's turn_end is ONE model response plus tools, not the user's whole run.
// agent_end can still be followed by retries/compaction. Only agent_settled
// (Pi 0.84) is terminal; keeping this distinction preserves the app's busy pill.

import {
  addUsage,
  emptyUsage,
  type EngineEvent,
  type UsageTotals,
} from "../engine/events.ts";
import { describeErrorText } from "../engine/errors.ts";
import { redactText } from "../util/redact.ts";

// Minimal structural view of the Pi session events we read. Kept loose (not the
// full Pi union) so this module type-checks without pinning to Pi's internals;
// the runtime shape is what the spike observed.
export interface PiSessionEvent {
  type: string;
  [k: string]: unknown;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

function normUsage(u: PiUsage | undefined): UsageTotals {
  const input = u?.input ?? 0;
  const output = u?.output ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: u?.cacheRead ?? 0,
    totalTokens: u?.totalTokens ?? input + output,
  };
}

function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  const parts = (result as any)?.content;
  if (Array.isArray(parts)) return parts.map((p: any) => p.text ?? `[${p.type}]`).join("");
  try {
    return JSON.stringify(result) ?? "";
  } catch {
    return String(result);
  }
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// Create a stateful adapter. One instance per session (it accumulates the
// running usage total). `toEngineEvents` returns zero-or-more EngineEvents for
// each Pi event; feed each through in `session.subscribe`.
export function createEngineEventAdapter() {
  let sessionTotal: UsageTotals = emptyUsage();
  let turnTotal: UsageTotals = emptyUsage();
  let lastMessage: any;
  let terminalSent = false;

  function toEngineEvents(ev: PiSessionEvent): EngineEvent[] {
    switch (ev.type) {
      case "agent_start":
        terminalSent = false;
        return [];

      case "message_update": {
        const a = ev.assistantMessageEvent as any;
        if (a?.type === "text_delta") return [{ type: "text", text: a.delta }];
        if (a?.type === "thinking_delta") return [{ type: "reasoning", text: a.delta }];
        return [];
      }

      case "tool_execution_start":
        return [
          {
            type: "tool-call",
            id: ev.toolCallId as string,
            name: ev.toolName as string,
            input: ev.args,
          },
        ];

      // Pi partial results are snapshots, NOT deltas. Transports bound these;
      // cloud redaction must see the full text BEFORE any tail truncation.
      case "tool_execution_update":
        return [{
          type: "tool-progress",
          id: ev.toolCallId as string,
          name: ev.toolName as string,
          output: textOf(ev.partialResult),
        }];

      case "tool_execution_end":
        return ev.isError
          ? [
              {
                type: "tool-error",
                id: ev.toolCallId as string,
                name: ev.toolName as string,
                error: textOf(ev.result),
              },
            ]
          : [
              {
                type: "tool-result",
                id: ev.toolCallId as string,
                name: ev.toolName as string,
                output: textOf(ev.result),
              },
            ];

      case "turn_end": {
        const msg = ev.message as any;
        const turn = normUsage(msg?.usage);
        sessionTotal = addUsage(sessionTotal, turn);
        turnTotal = addUsage(turnTotal, turn);
        lastMessage = msg;
        return [{ type: "usage", usage: sessionTotal, turn: turnTotal }, { type: "step-finish" }];
      }

      case "agent_settled": {
        if (terminalSent) return [];
        terminalSent = true;
        const msg = lastMessage;
        lastMessage = undefined;
        turnTotal = emptyUsage();
        // Failed model calls often resolve prompt() normally. Delay the error
        // until retries/overflow recovery are exhausted, but never hide it.
        if (msg?.stopReason === "error") {
          const raw = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
          const described = describeErrorText(raw, { provider: typeof msg.provider === "string" ? msg.provider : undefined });
          return [{
            type: "error",
            error: described?.message ?? redactText(raw || "The model call failed."),
            ...(described?.hint ? { hint: described.hint } : {}),
            ...(described?.retryable != null ? { retryable: described.retryable } : {}),
          }];
        }
        if (msg?.stopReason === "aborted") return [{ type: "aborted" }];
        return [{ type: "finish", usage: sessionTotal, finishReason: msg?.stopReason ?? "stop" }];
      }

      case "compaction_start":
        return [{ type: "step-finish" }];
      case "compaction_end":
        return [
          {
            type: "compacted",
            before: num(ev.beforeTokens ?? (ev as any).before),
            after: num(ev.afterTokens ?? (ev as any).after),
          },
        ];

      // Automatic transient-failure retry before any output streamed.
      // TODO(verify) Pi's auto-retry event name + fields.
      case "auto_retry":
      case "auto_retry_start":
        return [
          {
            type: "retrying",
            attempt: num(ev.attempt, 1),
            max: num(ev.max ?? (ev as any).maxAttempts, 1),
            delayMs: num(ev.delayMs ?? (ev as any).delay, 0),
            reason: String(ev.reason ?? (ev as any).error ?? "transient failure"),
          },
        ];

      // agent_end is only a low-level loop boundary. willRetry:false still
      // permits overflow compaction and queued continuation; never finish here.
      case "agent_end":
        return [];

      case "abort":
      case "aborted":
        if (terminalSent) return [];
        terminalSent = true;
        lastMessage = undefined;
        turnTotal = emptyUsage();
        return [{ type: "aborted" }];

      default:
        return [];
    }
  }

  return {
    toEngineEvents,
    // Current running total, for callers that want to snapshot session usage
    // outside the event stream.
    get sessionUsage(): UsageTotals {
      return sessionTotal;
    },
  };
}

export type EngineEventAdapter = ReturnType<typeof createEngineEventAdapter>;
