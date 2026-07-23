// The `create_routine` tool — lets the agent turn "summarize the news every morning"
// or "remind me at 3pm tomorrow" into a saved routine the scheduler harbor runs
// unattended (see src/harbor). Ported from tree-cli/src/tools/routine.ts, adapted to
// Pi's registerTool (TypeBox schema) with the in-tool ctx.gate.request removed: in
// the Pi model our permission-gate extension gates the tool_call itself (classify.ts
// gives it a "Create routine" prompt + flags email/webhook egress).

import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { configPath } from "../config/paths.ts";
import { newRoutineId, webhookName, type Routine } from "../routines/schema.ts";
import { triggerError, computeNextRun, describeTrigger } from "../routines/trigger.ts";
import { upsertRoutine } from "../routines/store.ts";
import { sendToHarbor, HarborNotRunningError } from "../harbor/ipc.ts";

const KNOWN_CHANNELS = new Set(["file", "relay", "notice", "cloud", "email"]);

function loadWebhooks(): Record<string, { url?: string }> {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")).webhooks ?? {};
  } catch {
    return {};
  }
}

function text(t: string) {
  return { content: [{ type: "text", text: t }], details: {} };
}

export const routineToolDefinition = {
  name: "create_routine",
  label: "Create Routine",
  description:
    "Create a routine: a saved task the scheduler runs unattended, either recurring (a cron " +
    "expression) or one-off (a specific datetime), and delivers the result. Use when the user asks " +
    "to be notified/updated on a cadence ('every morning', 'nightly') or at a future time ('at 3pm " +
    "tomorrow'). Set exactly one of `cron` or `at`. Confirm timing + delivery with the user first; " +
    "creating a routine prompts for approval. Runs use a safe read-only toolset unless `tools` grants more.",
  parameters: Type.Object({
    name: Type.String({ description: "Short unique label, e.g. 'morning-news'." }),
    cron: Type.Optional(Type.String({ description: "Recurring: 5-field cron, e.g. '0 8 * * *' (08:00 daily). Omit for one-off." })),
    at: Type.Optional(Type.String({ description: "One-off: ISO-8601 datetime, e.g. '2026-07-02T15:00:00'. Omit for recurring." })),
    prompt: Type.String({ description: "Self-contained instruction the agent runs when it fires." }),
    delivery: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Where to deliver: 'file' (default), 'notice', 'relay', 'cloud' (E2E-encrypted to your Privateer " +
          "account), 'email' (plaintext, opt-in), or 'webhook:<name>' (name must exist in config webhooks).",
      }),
    ),
    cwd: Type.Optional(Type.String({ description: "Working directory for the run. Defaults to the current one." })),
    model: Type.Optional(Type.String({ description: "Optional 'provider:model' or 'provider/model' override." })),
    tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allow-list; omit for the default safe set." })),
  }),
  async execute(
    _toolCallId: string,
    params: {
      name: string;
      cron?: string;
      at?: string;
      prompt: string;
      delivery?: string[];
      cwd?: string;
      model?: string;
      tools?: string[];
    },
    _signal?: AbortSignal,
    _onUpdate?: unknown,
    ctx?: { cwd?: string },
  ) {
    const { name, cron, at, prompt, delivery, cwd, model, tools } = params;

    const err = triggerError({ cron, at });
    if (err) return text(`Error: ${err}`);

    const chans = delivery && delivery.length > 0 ? delivery : ["file"];
    // Validate channels: known names or webhook:<name>.
    const bad = chans.filter((c) => !KNOWN_CHANNELS.has(c) && webhookName(c) === null);
    if (bad.length > 0) return text(`Error: unknown delivery channel(s): ${bad.join(", ")}.`);

    // Webhook targets must be pre-declared in config (the routine never carries a URL).
    const hooks = chans.map(webhookName).filter((n): n is string => n !== null);
    if (hooks.length > 0) {
      const configured = loadWebhooks();
      const unknown = hooks.filter((n) => !configured[n]);
      if (unknown.length > 0) {
        return text(
          `Error: webhook${unknown.length > 1 ? "s" : ""} not configured: ${unknown.join(", ")}. ` +
            `Declare them under "webhooks" in ~/.privateer/config.json first.`,
        );
      }
    }

    const next = computeNextRun({ cron, at });
    const routine: Routine = {
      id: newRoutineId(),
      name,
      cron,
      at,
      prompt,
      cwd: cwd ?? ctx?.cwd ?? process.cwd(),
      model,
      delivery: chans as Routine["delivery"],
      tools,
      enabled: true,
      nextRun: next?.toISOString(),
    };

    // Hand to the running harbor (it validates + schedules); fall back to writing the
    // file so the routine persists until the harbor starts.
    try {
      const res = await sendToHarbor({ cmd: "add", routine });
      if (!res.ok) return text(`Error saving routine: ${res.message ?? "unknown"}`);
      return text(
        `Created routine "${name}" (${describeTrigger({ cron, at })}). ` +
          `Next run ${next ? next.toLocaleString() : "unknown"}, delivery: ${chans.join(", ")}.`,
      );
    } catch (e) {
      if (e instanceof HarborNotRunningError) {
        upsertRoutine(routine);
        return text(
          `Saved routine "${name}" (${describeTrigger({ cron, at })}), but the scheduler harbor isn't ` +
            `running yet, so it won't fire until you start it.`,
        );
      }
      return text(`Error contacting the scheduler: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};
