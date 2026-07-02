import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { PermissionDeniedError } from "../permissions/gate.ts";
import { DELIVERY_CHANNELS, newRoutineId, type Routine } from "../routines/schema.ts";
import { triggerError, computeNextRun, describeTrigger } from "../routines/trigger.ts";
import { upsertRoutine } from "../routines/store.ts";
import { sendToDaemon, DaemonNotRunningError } from "../daemon/ipc.ts";

// Lets the agent turn a request like "summarize world news every morning" or
// "remind me at 3pm tomorrow" into a saved routine. Creating one is a persistent
// mutation, so it routes through the permission gate — the agent proposes, the user
// approves, then it lands in routines.json and the running daemon picks it up.
export function routineTool(ctx: ToolContext) {
  return tool({
    description:
      "Create a routine: a saved task the scheduler runs unattended, either recurring (a cron " +
      "expression) or one-off (a specific datetime), and delivers the result. Use when the user " +
      "asks to be notified/updated on a cadence ('every morning', 'nightly') or at a future time " +
      "('at 3pm tomorrow'). Set exactly one of `cron` or `at`. Confirm timing + delivery with the " +
      "user first; this prompts for approval before saving. Runs use a safe read/web toolset (no " +
      "writing or shell).",
    inputSchema: z.object({
      name: z.string().describe("Short unique label, e.g. 'morning-news'."),
      cron: z
        .string()
        .optional()
        .describe("Recurring: standard 5-field cron, e.g. '0 8 * * *' for 08:00 daily. Omit for one-off."),
      at: z
        .string()
        .optional()
        .describe("One-off: ISO-8601 datetime, e.g. '2026-07-02T15:00:00'. Omit for recurring."),
      prompt: z.string().describe("Self-contained instruction the agent runs when it fires."),
      delivery: z
        .array(z.enum(DELIVERY_CHANNELS))
        .optional()
        .describe("How to deliver the result. Defaults to ['file']. 'email' leaves the machine (opt-in)."),
      cwd: z.string().optional().describe("Working directory for the run. Defaults to the current one."),
      model: z.string().optional().describe("Optional 'provider:model' override."),
    }),
    execute: async ({ name, cron, at, prompt, delivery, cwd, model }) => {
      const err = triggerError({ cron, at });
      if (err) return `Error: ${err}`;

      const chans = delivery && delivery.length > 0 ? delivery : ["file" as const];
      const next = computeNextRun({ cron, at });
      const detail =
        `${name}: ${describeTrigger({ cron, at })}` +
        (next ? ` (next ${next.toLocaleString()})` : "") +
        ` → ${chans.join(",")}`;

      // Confirm with the user. Email egress is flagged so the human sees it.
      const decision = await ctx.gate.request({
        tool: "routine",
        kind: "write",
        title: "Create routine",
        detail: chans.includes("email") ? `${detail}  [email leaves your machine]` : detail,
      });
      if (decision === "deny") throw new PermissionDeniedError("routine");

      const routine: Routine = {
        id: newRoutineId(),
        name,
        cron,
        at,
        prompt,
        cwd: cwd ?? ctx.cwd,
        model,
        delivery: chans,
        enabled: true,
        nextRun: next?.toISOString(),
      };

      // Prefer handing it to the running daemon (it validates + schedules); fall back
      // to writing the file directly so the routine persists until the daemon starts.
      try {
        const res = await sendToDaemon({ cmd: "add", routine });
        if (!res.ok) return `Error saving routine: ${res.message ?? "unknown"}`;
        return `Created routine "${name}" (${describeTrigger({ cron, at })}). Next run ${next ? next.toLocaleString() : "unknown"}, delivery: ${chans.join(", ")}.`;
      } catch (e) {
        if (e instanceof DaemonNotRunningError) {
          upsertRoutine(routine);
          return (
            `Saved routine "${name}" (${describeTrigger({ cron, at })}), but the scheduler daemon isn't ` +
            `running yet, so it won't fire until you start it: run \`privateer daemon\` (or \`privateer daemon --detach\`).`
          );
        }
        return `Error contacting the scheduler: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
}
