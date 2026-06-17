// The permission gate is the seam between tools and the user's approval policy.
// Tools call `gate.request(...)` before any mutation or shell execution; the gate
// decides allow/deny based on the active permission mode (Phase 4) and may prompt
// the user interactively. Phase 2 ships a pass-through gate so tools work
// end-to-end; Phase 4 replaces it with the mode-aware interactive gate.

export type PermissionDecision = "allow" | "deny";

export type PermissionKind = "write" | "edit" | "bash" | "fetch" | "read";

export interface PermissionRequest {
  tool: string;
  kind: PermissionKind;
  title: string; // short action label, e.g. "Run command"
  detail: string; // the command, or file path + change preview
  protected?: boolean; // target is a guarded file: never auto-approve, always prompt
  // Target resolves outside the working directory: never auto-approve (unless bypass),
  // always prompt. `path` carries the absolute target so "always" can remember its dir.
  outside?: boolean;
  path?: string;
}

export interface PermissionGate {
  request(req: PermissionRequest): Promise<PermissionDecision>;
}

export const autoApproveGate: PermissionGate = {
  async request() {
    return "allow";
  },
};

export class PermissionDeniedError extends Error {
  constructor(tool: string) {
    super(`Permission denied for ${tool}`);
    this.name = "PermissionDeniedError";
  }
}
