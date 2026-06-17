import { readFileSync, existsSync, statSync } from "node:fs";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { resolveInCwd, displayPath, guardScope } from "./context.ts";

const MAX_LINES = 2000;
const MAX_LINE_LEN = 2000;

export function readTool(ctx: ToolContext) {
  return tool({
    description:
      "Read a file from the working directory. Returns the contents with line numbers. " +
      "Use offset/limit for large files. Read-only.",
    inputSchema: z.object({
      path: z.string().describe("File path, absolute or relative to the working directory."),
      offset: z.number().int().min(1).optional().describe("1-based line to start from."),
      limit: z.number().int().positive().optional().describe("Max lines to read."),
    }),
    execute: async ({ path, offset, limit }) => {
      const abs = resolveInCwd(ctx, path);
      const blocked = await guardScope(ctx, abs, { kind: "read", title: "Read outside working directory" });
      if (blocked) return blocked;
      if (!existsSync(abs)) return `Error: file not found: ${displayPath(ctx, abs)}`;
      if (statSync(abs).isDirectory()) return `Error: ${displayPath(ctx, abs)} is a directory.`;

      const start = (offset ?? 1) - 1;
      const max = limit ?? MAX_LINES;
      const lines = readFileSync(abs, "utf8").split("\n");
      const slice = lines.slice(start, start + max);
      const body = slice
        .map((line, i) => {
          const n = start + i + 1;
          const text = line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) + "…" : line;
          return `${String(n).padStart(6)}\t${text}`;
        })
        .join("\n");
      const more = start + max < lines.length ? `\n… (${lines.length - (start + max)} more lines)` : "";
      return body + more;
    },
  });
}
