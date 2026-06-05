import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";

// The planning tool: the model maintains a single flat task list, rewriting the
// whole list each call. State lives in the session's
// TodoStore so the TUI can render it live. No filesystem mutation, so it isn't gated.
export function todoTool(ctx: ToolContext) {
  return tool({
    description:
      "Record and update your task list for multi-step work. Pass the COMPLETE list every " +
      "time (it replaces the previous one). Keep exactly one item 'in_progress'; mark items " +
      "'completed' as you finish them. Use this to plan non-trivial tasks and keep the user oriented.",
    inputSchema: z.object({
      todos: z
        .array(
          z.object({
            content: z.string().describe("Imperative task description, e.g. 'Add auth middleware'."),
            status: z.enum(["pending", "in_progress", "completed"]),
            activeForm: z
              .string()
              .optional()
              .describe("Present-continuous label shown while running, e.g. 'Adding auth middleware'."),
          }),
        )
        .describe("The full task list, in order."),
    }),
    execute: async ({ todos }) => {
      ctx.todos?.set(todos);
      const done = todos.filter((t) => t.status === "completed").length;
      const active = todos.find((t) => t.status === "in_progress");
      const summary = `Updated todo list (${done}/${todos.length} done).`;
      return active ? `${summary} In progress: ${active.content}` : summary;
    },
  });
}
