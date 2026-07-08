import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { PermissionDeniedError } from "../permissions/gate.ts";
import { DeliveryEntry, webhookName, newRoutineId, type Routine } from "../routines/schema.ts";
import { loadConfig } from "../config/load.ts";
import { triggerError, computeNextRun, describeTrigger } from "../routines/trigger.ts";
import { splitRoutineTools } from "../routines/toolSelect.ts";
import { upsertRoutine } from "../routines/store.ts";
import { sendToDaemon, DaemonNotRunningError } from "../daemon/ipc.ts";

// The host of a webhook URL, for the approval flag — enough for the human to judge
// where results go without echoing tokens embedded in the path.
function hostOf(url?: string): string {
  try {
    return url ? new URL(url).host : "(unknown)";
  } catch {
    return "(invalid url)";
  }
}

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
      "writing or shell) unless `tools` grants more.",
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
        .array(DeliveryEntry)
        .optional()
        .describe(
          "How to deliver the result. Defaults to ['file']. 'cloud' stores an end-to-end-encrypted " +
            "copy in your Privateer account so the app catches up on it when next opened (the server " +
            "only ever sees ciphertext). 'email' and 'webhook:<name>' leave the machine in plaintext " +
            "(opt-in); webhook names must exist in the config `webhooks` section.",
        ),
      cwd: z.string().optional().describe("Working directory for the run. Defaults to the current one."),
      model: z.string().optional().describe("Optional 'provider:model' override."),
      tools: z
        .array(z.string())
        .optional()
        .describe(
          "Tool allow-list: builtin names ('read') and/or MCP selectors '<server>__<tool>' or " +
            "'<server>__*'. MCP tools run unattended with no approval prompts — grant only what " +
            "the task needs. Omit for the default safe read/web set.",
        ),
    }),
    execute: async ({ name, cron, at, prompt, delivery, cwd, model, tools }) => {
      const err = triggerError({ cron, at });
      if (err) return `Error: ${err}`;

      const chans = delivery && delivery.length > 0 ? delivery : ["file" as const];

      // Webhook entries must reference endpoints already declared in config — the
      // routine never carries a URL, and an unknown name fails here (at creation,
      // with a human in the loop) rather than silently at fire time.
      const hooks = chans.map(webhookName).filter((n): n is string => n !== null);
      const configuredHooks = hooks.length > 0 ? (loadConfig().webhooks ?? {}) : {};
      if (hooks.length > 0) {
        const unknown = hooks.filter((n) => !configuredHooks[n]);
        if (unknown.length > 0) {
          return (
            `Error: webhook${unknown.length > 1 ? "s" : ""} not configured: ${unknown.join(", ")}. ` +
            `Declare endpoints under "webhooks" in settings.json first (e.g. ` +
            `{"webhooks": {"${unknown[0]}": {"url": "https://…", "format": "slack"}}}).`
          );
        }
      }

      const next = computeNextRun({ cron, at });
      const detail =
        `${name}: ${describeTrigger({ cron, at })}` +
        (next ? ` (next ${next.toLocaleString()})` : "") +
        ` → ${chans.join(",")}`;

      // Confirm with the user. Egress grants are flagged so the human sees them:
      // email delivery, and any MCP tools — those run unattended under the daemon's
      // auto-approve gate, so this approval is the only human decision they get.
      const split = splitRoutineTools(tools);
      const flags: string[] = [];
      if (chans.includes("email")) flags.push("email leaves your machine");
      if (hooks.length > 0) {
        const targets = hooks.map((n) => `${n} → ${hostOf(configuredHooks[n]?.url)}`);
        flags.push(`posts results off-machine to webhook${hooks.length > 1 ? "s" : ""}: ${targets.join(", ")}`);
      }
      if (split.mcp.length > 0) flags.push(`grants external MCP tools, unattended: ${split.mcp.join(", ")}`);
      const decision = await ctx.gate.request({
        tool: "routine",
        kind: "write",
        title: "Create routine",
        detail: flags.length > 0 ? `${detail}  [${flags.join("] [")}]` : detail,
        // An MCP grant must always reach the human, above bypass mode/allowlists.
        alwaysAsk: split.mcp.length > 0,
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
        tools,
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
