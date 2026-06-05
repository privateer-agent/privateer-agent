import { resolve, isAbsolute, relative, sep } from "node:path";
import { realpathSync } from "node:fs";
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

// Resolve a possibly-relative path against the session cwd and keep it inside the
// working directory (basic guardrail against `../` escapes from the model).
export function resolveInCwd(ctx: ToolContext, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(ctx.cwd, p);
  if (isOutside(ctx.cwd, abs)) {
    throw new Error(`Path "${p}" is outside the working directory.`);
  }
  // Defense in depth: if the path (or its nearest existing parent) resolves through
  // a symlink to somewhere outside cwd, reject it. realpath only sees existing nodes,
  // so for not-yet-created files we canonicalize the closest existing ancestor.
  const realRoot = safeRealpath(ctx.cwd);
  const realTarget = safeRealpath(nearestExisting(abs));
  if (realRoot && realTarget && isOutside(realRoot, realTarget)) {
    throw new Error(`Path "${p}" resolves outside the working directory via a symlink.`);
  }
  return abs;
}

function isOutside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
}

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function nearestExisting(p: string): string {
  let cur = p;
  for (;;) {
    if (safeRealpath(cur)) return cur;
    const parent = resolve(cur, "..");
    if (parent === cur) return cur;
    cur = parent;
  }
}

// Display a path relative to cwd when possible (nicer for tool output / UI).
export function displayPath(ctx: ToolContext, abs: string): string {
  const rel = relative(ctx.cwd, abs);
  return rel === "" ? "." : rel;
}
