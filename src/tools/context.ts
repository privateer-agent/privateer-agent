import { resolve, isAbsolute, relative, sep } from "node:path";
import type { PermissionGate, PermissionKind } from "../permissions/gate.ts";
import type { TodoStore } from "./todoStore.ts";
import type { AgentDefinition } from "../agents/loader.ts";
import type { ProcessRegistry } from "./processRegistry.ts";
import type { AttachmentStore } from "../util/attachmentStore.ts";
import type { UserAsker } from "./askUser.ts";

// A finished sub-agent's result: its final text answer plus run metrics (how many
// tools it called and how many tokens it spent), so the UI can show a per-agent
// summary in the grouped "N agents finished" view.
export interface SubAgentResult {
  text: string;
  toolUses: number;
  tokens: number;
}

// Runs a child agent and resolves to its final text answer + metrics. With no `agent`
// it runs the default read-only sub-agent; with one it uses that agent's
// tools/model/instructions. Supplied by the session (which has the model + config);
// absent in bare tool contexts.
export type SubAgentRunner = (input: {
  description: string;
  prompt: string;
  agent?: AgentDefinition;
}) => Promise<SubAgentResult>;

// Shared state handed to every tool's execute().
export interface ToolContext {
  cwd: string;
  gate: PermissionGate;
  // When true (the default), the tools confine file access to `cwd`: a path that
  // resolves outside it (an absolute path elsewhere, or a `../` escape) is only
  // touched after the user explicitly approves it via the gate. Set false to let the
  // agent roam (e.g. the user launched with --no-confine / set confineToCwd:false).
  confineToCwd?: boolean;
  // Out-of-cwd directories the user has approved this session ("always" on an outside
  // prompt). A shared array, also held by the gate, so an approved sibling directory
  // isn't re-prompted on every file inside it. Paths under any of these count as
  // in-scope.
  allowedOutsideRoots?: string[];
  todos?: TodoStore; // session todo list, for the `todo` tool + TUI panel
  runSubAgent?: SubAgentRunner; // spawns a `task` sub-agent
  // Reports a finished `task` sub-agent's run metrics, keyed by the originating
  // tool-call id, so the TUI can annotate the grouped agents view with each agent's
  // tool-use and token counts. Best-effort; absent outside the interactive session.
  onSubAgentMetrics?: (toolCallId: string, m: { toolUses: number; tokens: number }) => void;
  // Called by write/edit just before they mutate a file, so the checkpoint store
  // can capture its pre-modification state for /rewind.
  recordMutation?: (abs: string) => void;
  // Background-shell registry, for bash run_in_background + bash_output/kill_shell.
  processes?: ProcessRegistry;
  // Session attachment store (decoded bytes of pasted/dropped files, by "#n"), for the
  // save_attachment tool to write one back to disk.
  attachments?: AttachmentStore;
  // Surfaces an `ask_user` question to the interactive UI and resolves with the
  // user's choice. Absent outside the live TUI (sub-agents, remote-driven turns,
  // headless runs) — the tool then reports it couldn't ask and the model proceeds.
  askUser?: UserAsker;
  // Streams a file to the connected remote controller (the Privateer app) over the
  // relay, for the send_file_to_client tool. Absent when remote access is off or in
  // bare/sub-agent/daemon contexts — the tool then reports it can't send.
  sendFileToController?: (file: {
    name: string;
    mediaType: string;
    base64: string;
    size: number;
  }) => Promise<{ ok: boolean; reason?: string }>;
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

// Is `abs` the directory `root` itself, or contained within it? Uses the resolved
// relative path so `..` escapes are caught regardless of how the path was written.
export function isInsideDir(root: string, abs: string): boolean {
  if (abs === root) return true;
  const rel = relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// Does this path fall outside the agent's working-directory scope? True only when
// confinement is on and the path is neither inside cwd nor inside a directory the
// user already approved this session.
export function isOutsideScope(ctx: ToolContext, abs: string): boolean {
  if (ctx.confineToCwd === false) return false;
  if (isInsideDir(ctx.cwd, abs)) return false;
  return !(ctx.allowedOutsideRoots ?? []).some((root) => isInsideDir(root, abs));
}

// Gate access to a path that may sit outside cwd. Returns null when the path is in
// scope or the user approves the out-of-scope access; returns an error string (for the
// tool to hand back to the model) when confinement blocks it. In-scope paths never
// prompt, so ordinary work inside cwd is untouched.
export async function guardScope(
  ctx: ToolContext,
  abs: string,
  opts: { kind: PermissionKind; title: string },
): Promise<string | null> {
  if (!isOutsideScope(ctx, abs)) return null;
  const decision = await ctx.gate.request({
    tool: opts.kind,
    kind: opts.kind,
    title: opts.title,
    detail: abs,
    path: abs,
    outside: true,
  });
  if (decision === "deny") {
    return (
      `Error: ${abs} is outside the working directory (${ctx.cwd}). ` +
      `By default I stay within the working directory; access here was declined. ` +
      `Ask me explicitly to work in this location to allow it.`
    );
  }
  return null;
}
