// Permission-gate vocabulary — the request shape the policy reasons about, and
// the decision it returns. Ported from tree-cli/src/permissions/gate.ts, trimmed
// to types only: in the 0.2 codebase each tool built a PermissionRequest and
// called ctx.gate.request(); in the Pi rewrite the gate is a `tool_call`
// extension hook that receives { toolName, input } and derives the request via
// classifyToolCall (see ./classify.ts). So the pass-through gate is gone; the
// live policy lives in ./mode.ts + ./modeGate.ts.

export type PermissionDecision = "allow" | "deny";

export type PermissionKind = "write" | "edit" | "bash" | "fetch" | "read";

export interface PermissionRequest {
  tool: string;
  kind: PermissionKind;
  title: string; // short action label, e.g. "Run command"
  detail: string; // the command, or file path + change preview
  protected?: boolean; // target is a guarded file: never auto-approve, always prompt
  // Always require a human decision, ABOVE bypass mode and the allowlist (like a
  // dangerous shell command). Set for tools that declare themselves destructive,
  // so even a "take no prisoners" run can't fire an irreversible action silently.
  // The decision is never remembered.
  alwaysAsk?: boolean;
  // Target resolves outside the working directory: never auto-approve (unless bypass),
  // always prompt. `path` carries the absolute target so "always" can remember its dir.
  outside?: boolean;
  path?: string;
}

// Implemented by ModeGate (./modeGate.ts). The extension builds one per tool_call.
export interface PermissionGate {
  request(req: PermissionRequest): Promise<PermissionDecision>;
}

export class PermissionDeniedError extends Error {
  constructor(tool: string) {
    super(`Permission denied for ${tool}`);
    this.name = "PermissionDeniedError";
  }
}
