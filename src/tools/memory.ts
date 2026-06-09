import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { saveMemory, deleteMemory } from "../memory/auto.ts";

// Records durable facts across runs (auto-memory). Unlike write/edit this is not gated:
// memory lives in the agent's own store, and the returned string surfaces in the
// transcript as a visible notice of what was saved.
export function memoryTool(ctx: ToolContext) {
  return tool({
    description:
      "Record or remove a durable memory that persists across sessions. Use it for facts " +
      "worth remembering long-term — user preferences, stable project conventions, and " +
      "feedback on how to work — not transient details. Memories are recalled into your " +
      "context automatically via the memory index. Prefer updating an existing memory " +
      "(same name) over creating a near-duplicate.",
    inputSchema: z.object({
      action: z.enum(["write", "delete"]).describe("Write/update a memory, or delete one."),
      name: z
        .string()
        .describe("Short kebab-case identifier, e.g. 'user-prefers-tabs'. Reuse to update."),
      description: z
        .string()
        .optional()
        .describe("One-line summary (required for write). Shown in the recalled index."),
      type: z
        .enum(["user", "feedback", "project", "reference"])
        .optional()
        .describe("user=about the user, feedback=how to work, project=ongoing work, reference=pointer."),
      scope: z
        .enum(["project", "global"])
        .optional()
        .describe("project (default) recalls only here; global recalls in every project."),
      content: z
        .string()
        .optional()
        .describe("The fact to remember (required for write). Link others with [[name]]."),
    }),
    execute: async ({ action, name, description, type, scope, content }) => {
      if (action === "delete") {
        const removed = deleteMemory(ctx.cwd, name);
        return removed
          ? `Deleted memory "${removed.name}" (${removed.scope}).`
          : `No memory named "${name}" to delete.`;
      }
      if (!description || !content) {
        return 'To write a memory, provide both "description" and "content".';
      }
      const rec = saveMemory(ctx.cwd, { name, description, type, scope, body: content });
      return `Saved memory "${rec.name}" (${rec.scope}, ${rec.type}).`;
    },
  });
}
