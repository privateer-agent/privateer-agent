import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { loadAgents, findAgent } from "../agents/loader.ts";

// Delegation tool: hand an open-ended investigation to a sub-agent that runs its own
// loop and returns just a summary, keeping the parent conversation small. Without a
// subagent_type it runs the default read-only agent (read/glob/grep); with one it uses
// that custom agent's tools/model/instructions. Sub-agents cannot spawn further
// sub-agents (no recursion).
//
// Note: this runs synchronously (one sub-agent at a time), not as async parallel
// workers.
export function taskTool(ctx: ToolContext) {
  const agents = loadAgents(ctx.cwd);
  const agentList = agents.length
    ? ` Available subagent_type values: ${agents.map((a) => `${a.name} (${a.description})`).join("; ")}.`
    : "";
  return tool({
    description:
      "Delegate a search or task to a sub-agent. Give it a complete, self-contained prompt; it " +
      "explores and returns a text summary, keeping the main thread focused. Omit subagent_type " +
      "for the default read-only agent (read/glob/grep, cannot modify files)." +
      agentList,
    inputSchema: z.object({
      description: z.string().describe("Short 3–6 word description of the task."),
      prompt: z.string().describe("The full, self-contained task for the sub-agent."),
      subagent_type: z.string().optional().describe("Name of a custom sub-agent to use."),
    }),
    execute: async ({ description, prompt, subagent_type }) => {
      if (!ctx.runSubAgent) return "Sub-agents are not available in this context.";
      let agent;
      if (subagent_type) {
        agent = findAgent(subagent_type, ctx.cwd);
        if (!agent) {
          const names = loadAgents(ctx.cwd).map((a) => a.name).join(", ") || "(none defined)";
          return `No sub-agent named "${subagent_type}". Available: ${names}.`;
        }
      }
      try {
        return await ctx.runSubAgent({ description, prompt, agent });
      } catch (err) {
        return `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
