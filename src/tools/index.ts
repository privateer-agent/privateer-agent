import type { ToolSet } from "ai";
import type { ToolContext } from "./context.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { bashTool } from "./bash.ts";
import { todoTool } from "./todo.ts";
import { taskTool } from "./task.ts";
import { webFetchTool, webSearchTool } from "./web.ts";

export type { ToolContext } from "./context.ts";

// Build the full toolset bound to a session context (cwd + permission gate + todo store).
export function createTools(ctx: ToolContext): ToolSet {
  return {
    read: readTool(ctx),
    write: writeTool(ctx),
    edit: editTool(ctx),
    glob: globTool(ctx),
    grep: grepTool(ctx),
    bash: bashTool(ctx),
    todo: todoTool(ctx),
    task: taskTool(ctx),
    web_fetch: webFetchTool(ctx),
    web_search: webSearchTool(ctx),
  };
}

// The read-only subset given to `task` sub-agents: search + inspect, no mutation, no
// recursion (no `task`/`todo`). Safe to run with an auto-approve gate.
export function createReadOnlyTools(ctx: ToolContext): ToolSet {
  return {
    read: readTool(ctx),
    glob: globTool(ctx),
    grep: grepTool(ctx),
  };
}
