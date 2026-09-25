// SPEND PRE-APPROVAL FOR ONE HEADLESS RUN, typed on the command line.
//
//   privateer -p --allow-spend generate_video --max-calls 1 --max-spend 1.00 "…"
//
// THE PROBLEM. A `-p` run has no screen, so the gate's local asker has nobody to ask
// and every billing tool — each one `alwaysAsk` — is denied. An agent driving Privateer
// from a script could plan a whole film and only discover at the last step that the
// one call that mattered could never be approved. The routine grant (childSpend.ts)
// solves this for scheduled runs; this is the same idea for a run a person starts.
//
// WHY A FLAG, NOT AN ENV VAR. The grant is typed per invocation, capped, and gone when
// the process exits. The launcher carries it to the gate in PRIVATEER_CLI_SPEND — the
// only channel into Pi's process — but deletes any inherited value before parsing argv
// (bin/privateer-launch.mjs), so an export lingering in someone's shell never counts.
// And it is honoured only where the flag can apply: a TOP-LEVEL headless session. Not
// the TUI (a person approves each call there), and not a subagent child (a child's
// grant comes only from childSpend.ts, whose caps this ledger does not share).
//
// WHAT IT LIFTS. Exactly what the routine grant lifts, through the same
// ModeGate.isSpendPreauthorized hook and under the same guards: `alwaysAsk` must be the
// only reason to ask, and a call that leaves the working directory or touches a
// protected file is never covered. On top of that, two caps:
//
//   • --max-calls counts calls this ledger ALLOWED, not calls that succeeded — a call
//     that then fails server-side still used its slot. Over-counting is the safe error.
//   • --max-spend is checked BEFORE each call against the server's own reservation
//     figure for that exact call (tools/media.ts quoteMediaCallUsd), which is
//     worst-case by design. A call that can't be priced is REFUSED under a dollar cap
//     rather than waved through — a cap that skips what it can't measure isn't one.

import type { PermissionRequest } from "./gate.ts";
import { BILLED_MEDIA_TOOLS } from "./classify.ts";

/** The env var the launcher writes from `--allow-spend` (mirrors bin/headless-flags.mjs). */
export const CLI_SPEND_ENV = "PRIVATEER_CLI_SPEND";

export interface CliSpendGrant {
  tools: string[];
  maxCalls?: number;
  maxSpendUsd?: number;
}

/**
 * The grant this run was launched with, or null. Defensive: anything malformed, any
 * tool that isn't a billing tool, or a grant with no cap at all reads as NO grant —
 * the launcher never writes one of those, so seeing one means it didn't come from it.
 */
export function readCliSpendGrant(env: NodeJS.ProcessEnv = process.env): CliSpendGrant | null {
  const raw = env[CLI_SPEND_ENV];
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const g = parsed as Partial<CliSpendGrant>;
  if (!g || !Array.isArray(g.tools)) return null;
  const tools = g.tools.filter((t): t is string => typeof t === "string" && BILLED_MEDIA_TOOLS.has(t));
  if (tools.length === 0) return null;
  const maxCalls = Number.isInteger(g.maxCalls) && (g.maxCalls as number) > 0 ? (g.maxCalls as number) : undefined;
  const maxSpendUsd =
    typeof g.maxSpendUsd === "number" && Number.isFinite(g.maxSpendUsd) && g.maxSpendUsd > 0 ? g.maxSpendUsd : undefined;
  if (maxCalls === undefined && maxSpendUsd === undefined) return null;
  return { tools, ...(maxCalls !== undefined ? { maxCalls } : {}), ...(maxSpendUsd !== undefined ? { maxSpendUsd } : {}) };
}

/** Price one call of `tool` with these arguments, in USD; null when it can't be priced. */
export type SpendQuote = (tool: string, input: unknown, signal?: AbortSignal) => Promise<number | null>;

export type SpendDecision = { ok: true; usd: number | null } | { ok: false; reason: string };

const money = (n: number): string => `$${n.toFixed(2)}`;

/**
 * The running tally for one grant. One per process: the caps are for the whole run.
 */
export class CliSpendLedger {
  private calls = 0;
  private spentUsd = 0;

  constructor(
    readonly grant: CliSpendGrant,
    private readonly quote: SpendQuote,
  ) {}

  /**
   * May this call spend? Records it when it may. The check and the record happen in
   * one synchronous step after the (async) quote, so two calls racing in parallel can't
   * both squeeze under the same remaining budget.
   */
  async authorize(tool: string, input: unknown, signal?: AbortSignal): Promise<SpendDecision> {
    const { tools, maxCalls, maxSpendUsd } = this.grant;
    if (!tools.includes(tool)) {
      return { ok: false, reason: `this run's --allow-spend covers ${tools.join(", ")}, not ${tool}` };
    }
    if (maxCalls !== undefined && this.calls >= maxCalls) {
      return { ok: false, reason: `this run's --max-calls ${maxCalls} is used up` };
    }
    let usd: number | null = null;
    if (maxSpendUsd !== undefined) {
      try {
        usd = await this.quote(tool, input, signal);
      } catch {
        usd = null;
      }
      if (usd === null) {
        return {
          ok: false,
          reason:
            `${tool} can't be priced before it runs, so it can't be checked against --max-spend ${money(maxSpendUsd)}` +
            (tool === "generate_image" || tool === "generate_sprite"
              ? " (a call that overrides the image model is one of those — leave `model`/`image_model` unset)"
              : "") +
            ". Cap this run with --max-calls instead",
        };
      }
      // Recheck after the await: a parallel call may have spent while we were quoting.
      if (maxCalls !== undefined && this.calls >= maxCalls) {
        return { ok: false, reason: `this run's --max-calls ${maxCalls} is used up` };
      }
      if (this.spentUsd + usd > maxSpendUsd + 1e-9) {
        return {
          ok: false,
          reason:
            `this call is estimated at ${money(usd)} and only ${money(Math.max(0, maxSpendUsd - this.spentUsd))} ` +
            `of this run's --max-spend ${money(maxSpendUsd)} is left`,
        };
      }
      this.spentUsd += usd;
    }
    this.calls++;
    return { ok: true, usd };
  }

  /** One line for the end of the run / a denial: what the grant has used so far. */
  summary(): string {
    const { maxCalls, maxSpendUsd } = this.grant;
    const parts = [`${this.calls}${maxCalls !== undefined ? `/${maxCalls}` : ""} billed call(s)`];
    if (maxSpendUsd !== undefined) parts.push(`~${money(this.spentUsd)} of ${money(maxSpendUsd)} estimated`);
    return parts.join(", ");
  }
}

/**
 * The guidance a headless run gives when a billed call hits the gate with nothing to
 * approve it — written for the MODEL as much as the person, since the model is the one
 * that reads a tool denial and decides what to do next. It names every way out.
 */
export function headlessSpendGuidance(tool: string, cmd = process.env.PRIVATEER_CMD || "privateer"): string {
  return (
    `This is a headless run (-p) with no one at a screen to approve ${tool}, which bills the account. ` +
    `It can't be approved from inside this run. To allow it, the person running Privateer can re-run with ` +
    `\`${cmd} -p --allow-spend ${tool} --max-calls 1\` (optionally --max-spend <usd>), add --approve-in-app to ` +
    `approve it from the Privateer app, or drive Privateer over ACP (\`${cmd} acp\`), where the controlling ` +
    `program is asked. Stop and report this rather than retrying.`
  );
}

/** Is this the request a CLI grant could ever cover? (Billing tool, and billing is the only ask.) */
export function isSpendRequest(req: PermissionRequest): boolean {
  return req.alwaysAsk === true && BILLED_MEDIA_TOOLS.has(req.tool);
}
