import type { ToolSet } from "ai";
import type { ToolContext } from "./context.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { bashTool, bashOutputTool, killShellTool } from "./bash.ts";
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
    bash_output: bashOutputTool(ctx),
    kill_shell: killShellTool(ctx),
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

// Factories a sub-agent may be granted. Deliberately excludes `task` and `todo` so
// sub-agents can't recurse or mutate the parent's todo list.
const AGENT_TOOL_FACTORIES: Record<string, (ctx: ToolContext) => ToolSet[string]> = {
  read: readTool,
  write: writeTool,
  edit: editTool,
  glob: globTool,
  grep: grepTool,
  bash: bashTool,
  web_fetch: webFetchTool,
  web_search: webSearchTool,
};

// Build a sub-agent's toolset from a list of tool names; unknown names are ignored.
// Falls back to the read-only set when the list is empty or yields nothing.
export function createToolSubset(ctx: ToolContext, names?: string[]): ToolSet {
  const set: ToolSet = {};
  for (const n of names ?? []) {
    const factory = AGENT_TOOL_FACTORIES[n];
    if (factory) set[n] = factory(ctx);
  }
  return Object.keys(set).length > 0 ? set : createReadOnlyTools(ctx);
}
