import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { resolveInCwd, displayPath, isOutsideScope } from "./context.ts";
import { PermissionDeniedError } from "../permissions/gate.ts";
import { isProtectedPath } from "../permissions/protected.ts";

export function writeTool(ctx: ToolContext) {
  return tool({
    description:
      "Write a file, creating parent directories as needed. Overwrites existing files. " +
      "Prefer the edit tool for small changes to existing files.",
    inputSchema: z.object({
      path: z.string().describe("File path to write."),
      content: z.string().describe("Full file contents."),
    }),
    execute: async ({ path, content }) => {
      const abs = resolveInCwd(ctx, path);
      const exists = existsSync(abs);
      const outside = isOutsideScope(ctx, abs);
      const decision = await ctx.gate.request({
        tool: "write",
        kind: "write",
        title: outside ? "Write outside working directory" : exists ? "Overwrite file" : "Create file",
        detail: `${outside ? abs : displayPath(ctx, abs)} (${content.split("\n").length} lines)`,
        protected: isProtectedPath(abs),
        outside,
        path: abs,
      });
      if (decision === "deny") throw new PermissionDeniedError("write");

      ctx.recordMutation?.(abs);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      return `${exists ? "Wrote" : "Created"} ${displayPath(ctx, abs)} (${content.length} bytes).`;
    },
  });
}
