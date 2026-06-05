import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { exec } from "./exec.ts";
import { PermissionDeniedError } from "../permissions/gate.ts";

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;

export function bashTool(ctx: ToolContext) {
  return tool({
    description:
      "Run a shell command in the working directory and return its output. " +
      "Use for builds, tests, git, and other CLI tasks. Avoid long-running/interactive commands.",
    inputSchema: z.object({
      command: z.string().describe("The shell command to run."),
      timeout: z.number().int().positive().optional().describe("Timeout in ms (max 600000)."),
      run_in_background: z
        .boolean()
        .optional()
        .describe("Run detached and return immediately; poll with bash_output, stop with kill_shell."),
    }),
    execute: async ({ command, timeout, run_in_background }) => {
      const decision = await ctx.gate.request({
        tool: "bash",
        kind: "bash",
        title: run_in_background ? "Run command (background)" : "Run command",
        detail: command,
      });
      if (decision === "deny") throw new PermissionDeniedError("bash");

      if (run_in_background) {
        if (!ctx.processes) return "Background execution is not available in this context.";
        const id = ctx.processes.spawn(command, ctx.cwd);
        return `Started in background as ${id}. Read output with bash_output(bash_id="${id}"); stop with kill_shell(bash_id="${id}").`;
      }

      const timeoutMs = Math.min(timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
      const { stdout, stderr, code, timedOut } = await exec(command, [], {
        cwd: ctx.cwd,
        timeoutMs,
        shell: true,
      });

      const parts: string[] = [];
      if (stdout.trim()) parts.push(stdout.trimEnd());
      if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
      if (timedOut) parts.push(`[timed out after ${timeoutMs}ms]`);
      parts.push(`[exit code ${code ?? "null"}]`);
      return parts.join("\n");
    },
  });
}

export function bashOutputTool(ctx: ToolContext) {
  return tool({
    description:
      "Read new output from a background shell started with bash run_in_background. Returns only " +
      "output produced since the previous read, plus the shell's status.",
    inputSchema: z.object({
      bash_id: z.string().describe("The background shell id (e.g. bash_1)."),
    }),
    execute: async ({ bash_id }) => {
      if (!ctx.processes) return "Background processes are not available in this context.";
      const r = ctx.processes.read(bash_id);
      if (!r) return `No background shell "${bash_id}".`;
      const head = `[${r.status}${r.status === "exited" ? `, exit ${r.code ?? "null"}` : ""}]`;
      return r.output ? `${head}\n${r.output.trimEnd()}` : `${head} (no new output)`;
    },
  });
}

export function killShellTool(ctx: ToolContext) {
  return tool({
    description: "Stop a background shell started with bash run_in_background.",
    inputSchema: z.object({
      bash_id: z.string().describe("The background shell id to stop."),
    }),
    execute: async ({ bash_id }) => {
      if (!ctx.processes) return "Background processes are not available in this context.";
      return ctx.processes.kill(bash_id) ? `Stopped ${bash_id}.` : `No background shell "${bash_id}".`;
    },
  });
}
