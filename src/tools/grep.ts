import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { resolveInCwd, guardScope } from "./context.ts";
import { walkFiles } from "./walk.ts";

const MAX_MATCHES = 200;

// Treat a file as binary (and skip it) if an early chunk contains a NUL byte.
function looksBinary(buf: string): boolean {
  const head = buf.slice(0, 1024);
  for (let i = 0; i < head.length; i++) {
    if (head.charCodeAt(i) === 0) return true;
  }
  return false;
}

// Pure-Node content search. Walks files, optionally filtered by a glob, and reports
// regex matches as "file:line:text". No external binary dependency.
export function grepTool(ctx: ToolContext) {
  return tool({
    description:
      "Search file contents with a regular expression. Returns matching lines as " +
      "file:line:text. Optionally restrict to files matching a glob. Read-only.",
    inputSchema: z.object({
      pattern: z.string().describe("Regex pattern to search for (JavaScript regex syntax)."),
      path: z.string().optional().describe("File or directory to search (default: working directory)."),
      glob: z.string().optional().describe("Only search files matching this glob, e.g. '**/*.ts'."),
      ignore_case: z.boolean().optional().describe("Case-insensitive search."),
    }),
    execute: async ({ pattern, path, glob, ignore_case }) => {
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignore_case ? "i" : "");
      } catch (err) {
        return `Error: invalid regex: ${(err as Error).message}`;
      }

      const root = path ? resolveInCwd(ctx, path) : ctx.cwd;
      const blocked = await guardScope(ctx, root, { kind: "read", title: "Search outside working directory" });
      if (blocked) return blocked;
      let files: string[];
      let baseDir: string;
      try {
        if (statSync(root).isFile()) {
          baseDir = ctx.cwd;
          files = [root];
        } else {
          baseDir = root;
          const rel = walkFiles(root);
          const isMatch = glob ? picomatch(glob, { dot: true }) : () => true;
          files = rel.filter((f) => isMatch(f)).map((f) => join(root, f));
        }
      } catch {
        return `Error: path not found: ${path}`;
      }

      const results: string[] = [];
      for (const file of files) {
        if (results.length >= MAX_MATCHES) break;
        let content: string;
        try {
          content = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        if (looksBinary(content)) continue;
        const rel = file.startsWith(baseDir) ? file.slice(baseDir.length).replace(/^[/\\]/, "") : file;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push(`${rel}:${i + 1}:${lines[i].slice(0, 300)}`);
            if (results.length >= MAX_MATCHES) break;
          }
        }
      }

      if (results.length === 0) return "No matches.";
      const capped = results.length >= MAX_MATCHES ? "\n… (more matches truncated)" : "";
      return results.join("\n") + capped;
    },
  });
}
