import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { resolveInCwd, displayPath, isOutsideScope } from "./context.ts";
import { PermissionDeniedError } from "../permissions/gate.ts";
import { isProtectedPath } from "../permissions/protected.ts";

// Count occurrences of a substring (non-overlapping).
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

export function editTool(ctx: ToolContext) {
  return tool({
    description:
      "Replace an exact string in a file. old_string must match uniquely unless replace_all is set. " +
      "Include enough surrounding context to make the match unique.",
    inputSchema: z.object({
      path: z.string().describe("File to edit."),
      old_string: z.string().describe("Exact text to replace."),
      new_string: z.string().describe("Replacement text."),
      replace_all: z.boolean().optional().describe("Replace every occurrence."),
    }),
    execute: async ({ path, old_string, new_string, replace_all }) => {
      const abs = resolveInCwd(ctx, path);
      if (!existsSync(abs)) return `Error: file not found: ${displayPath(ctx, abs)}`;
      if (old_string === new_string) return `Error: old_string and new_string are identical.`;

      const original = readFileSync(abs, "utf8");
      const occ = countOccurrences(original, old_string);
      if (occ === 0) return `Error: old_string not found in ${displayPath(ctx, abs)}.`;
      if (occ > 1 && !replace_all) {
        return `Error: old_string matches ${occ} places in ${displayPath(ctx, abs)}. Add context or set replace_all.`;
      }

      const updated = replace_all
        ? original.split(old_string).join(new_string)
        : original.replace(old_string, new_string);

      const removed = old_string.split("\n").length;
      const added = new_string.split("\n").length;
      const outside = isOutsideScope(ctx, abs);
      const decision = await ctx.gate.request({
        tool: "edit",
        kind: "edit",
        title: outside ? "Edit outside working directory" : "Edit file",
        detail: `${outside ? abs : displayPath(ctx, abs)} (${replace_all ? occ + "×, " : ""}-${removed} +${added})`,
        protected: isProtectedPath(abs),
        outside,
        path: abs,
      });
      if (decision === "deny") throw new PermissionDeniedError("edit");

      ctx.recordMutation?.(abs);
      writeFileSync(abs, updated, "utf8");
      return `Edited ${displayPath(ctx, abs)} (${replace_all ? occ + " replacements" : "1 replacement"}).`;
    },
  });
}
