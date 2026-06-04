import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";

// Claude Code's AgentTool, scaled down: delegate an open-ended investigation to a
// read-only sub-agent that runs its own loop and returns just a summary, keeping the
// parent conversation small. The sub-agent has read/glob/grep only — it cannot mutate
// the filesystem or spawn further sub-agents (no recursion).
//
// Caveat vs. CC: this runs synchronously (one sub-agent at a time), not as async
// parallel workers.
export function taskTool(ctx: ToolContext) {
  return tool({
    description:
      "Delegate a broad search or investigation to a read-only sub-agent. Give it a complete, " +
      "self-contained prompt; it explores with read/glob/grep and returns a text summary. Use " +
      "this for open-ended questions ('where is X handled?', 'how does Y work?') to keep the main " +
      "thread focused. It cannot modify files or run commands.",
    inputSchema: z.object({
      description: z.string().describe("Short 3–6 word description of the task."),
      prompt: z.string().describe("The full, self-contained task for the sub-agent."),
    }),
    execute: async ({ description, prompt }) => {
      if (!ctx.runSubAgent) return "Sub-agents are not available in this context.";
      try {
        return await ctx.runSubAgent({ description, prompt });
      } catch (err) {
        return `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
