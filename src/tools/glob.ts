import { statSync } from "node:fs";
import picomatch from "picomatch";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { resolveInCwd, guardScope } from "./context.ts";
import { walkFiles } from "./walk.ts";

// Pure-Node glob: walk the tree and match relative paths with picomatch. No
// external binary dependency, so it works anywhere Privateer is installed.
export function globTool(ctx: ToolContext) {
  return tool({
    description:
      "Find files matching a glob pattern (e.g. '**/*.ts', 'src/**/test_*.py'). " +
      "Skips node_modules/.git/build dirs. Returns matching file paths. Read-only.",
    inputSchema: z.object({
      pattern: z.string().describe("Glob pattern to match file paths (relative to the search dir)."),
      path: z.string().optional().describe("Directory to search in (default: working directory)."),
    }),
    execute: async ({ pattern, path }) => {
      const root = path ? resolveInCwd(ctx, path) : ctx.cwd;
      const blocked = await guardScope(ctx, root, { kind: "read", title: "Search outside working directory" });
      if (blocked) return blocked;
      try {
        if (!statSync(root).isDirectory()) return `Error: ${path} is not a directory.`;
      } catch {
        return `Error: directory not found: ${path}`;
      }

      const isMatch = picomatch(pattern, { dot: true });
      const files = walkFiles(root).filter((f) => isMatch(f));
      if (files.length === 0) return "No files matched.";
      files.sort();
      const shown = files.slice(0, 200);
      const more = files.length > shown.length ? `\n… (${files.length - shown.length} more)` : "";
      return shown.join("\n") + more;
    },
  });
}
