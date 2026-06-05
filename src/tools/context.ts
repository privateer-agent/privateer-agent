import { resolve, isAbsolute, relative } from "node:path";
import type { PermissionGate } from "../permissions/gate.ts";
import type { TodoStore } from "./todoStore.ts";
import type { AgentDefinition } from "../agents/loader.ts";
import type { ProcessRegistry } from "./processRegistry.ts";

// Runs a child agent and resolves to its final text answer. With no `agent` it runs the
// default read-only sub-agent; with one it uses that agent's tools/model/instructions.
// Supplied by the session (which has the model + config); absent in bare tool contexts.
export type SubAgentRunner = (input: {
  description: string;
  prompt: string;
  agent?: AgentDefinition;
}) => Promise<string>;

// Shared state handed to every tool's execute().
export interface ToolContext {
  cwd: string;
  gate: PermissionGate;
  todos?: TodoStore; // session todo list, for the `todo` tool + TUI panel
  runSubAgent?: SubAgentRunner; // spawns a `task` sub-agent
  // Called by write/edit just before they mutate a file, so the checkpoint store
  // can capture its pre-modification state for /rewind.
  recordMutation?: (abs: string) => void;
  // Background-shell registry, for bash run_in_background + bash_output/kill_shell.
  processes?: ProcessRegistry;
}

// Resolve a possibly-relative path against the session cwd. The cwd is a *soft*
// anchor: relative paths are interpreted from it, but absolute paths and `../`
// escapes are allowed through — the model is nudged (via the system prompt) to
// stay inside cwd rather than being walled in here.
export function resolveInCwd(ctx: ToolContext, p: string): string {
  return isAbsolute(p) ? p : resolve(ctx.cwd, p);
}

// Display a path relative to cwd when possible (nicer for tool output / UI).
export function displayPath(ctx: ToolContext, abs: string): string {
  const rel = relative(ctx.cwd, abs);
  return rel === "" ? "." : rel;
}
