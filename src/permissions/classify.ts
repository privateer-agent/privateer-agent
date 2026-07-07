import { resolve, isAbsolute, relative } from "node:path";
import { isProtectedPath } from "./protected.ts";
import type { PermissionRequest } from "./gate.ts";

// NEW glue for the Pi rewrite. In 0.2 each tool built its own PermissionRequest
// before calling ctx.gate.request(). Pi's `tool_call` hook instead hands us
// { toolName, input }, so the classification — which kind of action is this, does
// it touch a protected/outside path — moves here. Field extraction is defensive
// across Pi's builtin input shapes (command/cmd, path/file_path/file).
//
// Returns null when the call needs no gate (a read-only builtin acting inside
// scope, or a known-safe meta tool): the hook then lets it run untouched, so
// ordinary in-cwd work has zero friction.

export interface ScopeOptions {
  cwd: string;
  confineToCwd?: boolean; // default true
  allowedOutsideRoots?: string[];
}

function resolveInCwd(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function isInsideDir(root: string, abs: string): boolean {
  if (abs === root) return true;
  const rel = relative(root, abs);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// Outside the agent's working-directory scope? Only when confinement is on and the
// path is neither inside cwd nor inside a session-approved outside root.
export function isOutsideScope(scope: ScopeOptions, abs: string): boolean {
  if (scope.confineToCwd === false) return false;
  if (isInsideDir(scope.cwd, abs)) return false;
  return !(scope.allowedOutsideRoots ?? []).some((root) => isInsideDir(root, abs));
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function firstPath(input: Record<string, unknown>): string {
  return str(input.path ?? input.file_path ?? input.file ?? input.filename ?? input.dir ?? input.directory);
}

// Known-safe read-only / meta builtins that never mutate and never leave the
// machine: no gate regardless of arguments. Tunable — the conservative default for
// anything NOT listed here is to ask (see below). TODO(verify) against Pi's full
// builtin tool catalog as it's enumerated in Phase 5.
const NON_GATED = new Set([
  "todo", "todowrite", "todo_write", "todoread", "think", "plan_note",
]);

// Read-ish builtins: gated ONLY when the target resolves outside scope.
const READ_TOOLS = new Set(["read", "cat", "grep", "find", "glob", "ls", "tree", "view"]);
const EDIT_TOOLS = new Set(["edit", "edit_file", "str_replace", "str_replace_editor", "apply_patch", "patch"]);
const WRITE_TOOLS = new Set(["write", "write_file", "create_file", "create"]);
const BASH_TOOLS = new Set(["bash", "shell", "run", "exec", "sh"]);

export function classifyToolCall(
  toolName: string,
  input: unknown,
  scope: ScopeOptions,
): PermissionRequest | null {
  const name = toolName.toLowerCase();
  const obj: Record<string, unknown> =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  if (NON_GATED.has(name)) return null;

  // Creating a routine is a persistent mutation; surface the trigger + delivery, and
  // force a human decision (alwaysAsk) when it grants off-machine egress.
  if (name === "create_routine" || name === "routine") {
    const label = str(obj.name) || "routine";
    const trigger = obj.cron ? `cron ${str(obj.cron)}` : obj.at ? `at ${str(obj.at)}` : "(no trigger)";
    const delivery = Array.isArray(obj.delivery) ? (obj.delivery as unknown[]).map(String) : ["file"];
    const egress: string[] = [];
    if (delivery.includes("email")) egress.push("email leaves the machine");
    if (delivery.some((d) => d.startsWith("webhook:"))) egress.push("posts to a webhook off-machine");
    return {
      tool: toolName,
      kind: "write",
      title: "Create routine",
      detail: `${label}: ${trigger} → ${delivery.join(",")}${egress.length ? ` [${egress.join("] [")}]` : ""}`,
      alwaysAsk: egress.length > 0,
    };
  }

  // Shell — the whole command is the detail (danger scanning runs on it).
  if (BASH_TOOLS.has(name)) {
    const command = str(obj.command ?? obj.cmd ?? obj.script);
    return { tool: toolName, kind: "bash", title: "Run command", detail: command };
  }

  // Write — create/overwrite a file.
  if (WRITE_TOOLS.has(name)) {
    const p = firstPath(obj);
    const abs = resolveInCwd(scope.cwd, p);
    const outside = isOutsideScope(scope, abs);
    return {
      tool: toolName,
      kind: "write",
      title: outside ? "Write outside working directory" : "Write file",
      detail: outside ? abs : p,
      protected: isProtectedPath(abs),
      outside,
      path: abs,
    };
  }

  // Edit — modify an existing file.
  if (EDIT_TOOLS.has(name)) {
    const p = firstPath(obj);
    const abs = resolveInCwd(scope.cwd, p);
    const outside = isOutsideScope(scope, abs);
    return {
      tool: toolName,
      kind: "edit",
      title: outside ? "Edit outside working directory" : "Edit file",
      detail: outside ? abs : p,
      protected: isProtectedPath(abs),
      outside,
      path: abs,
    };
  }

  // Read-ish — no gate in scope; when the target is outside scope, prompt.
  if (READ_TOOLS.has(name)) {
    const p = firstPath(obj);
    if (!p) return null; // e.g. grep with no explicit path → in-cwd, no gate
    const abs = resolveInCwd(scope.cwd, p);
    if (!isOutsideScope(scope, abs)) return null;
    return {
      tool: toolName,
      kind: "read",
      title: "Read outside working directory",
      detail: abs,
      outside: true,
      path: abs,
    };
  }

  // Network reads (web fetch / search / http).
  if (name.includes("fetch") || name.includes("web") || name.includes("http") || name.includes("url")) {
    return {
      tool: toolName,
      kind: "fetch",
      title: "Fetch from the network",
      detail: str(obj.url ?? obj.query ?? obj.q),
    };
  }

  // Unknown / custom / MCP tool: we can't prove it's side-effect-free, so
  // safe-by-default is to prompt. Classified as a bash-kind action (asks in
  // default/acceptEdits, denies in plan, allows only under bypass). Phase 5 refines
  // this with MCP destructiveHint → alwaysAsk and a per-tool policy map.
  return {
    tool: toolName,
    kind: "bash",
    title: `Run ${toolName}`,
    detail: safeJson(obj),
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
