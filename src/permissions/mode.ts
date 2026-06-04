import type { PermissionMode } from "../config/schema.ts";
import type { PermissionRequest } from "./gate.ts";

export type AutoDecision = "allow" | "deny" | "ask";

// Is a bash command covered by the allowlist? Entries are command prefixes:
// "git status" allows exactly that and "git status --short", but not "git push".
export function isAllowlisted(command: string, allowlist: string[]): boolean {
  const cmd = command.trim();
  return allowlist.some((entry) => {
    const e = entry.trim();
    return e !== "" && (cmd === e || cmd.startsWith(e + " "));
  });
}

// Decide what to do with a permission request from the current mode + allowlist,
// before involving the user. Returns "ask" when interactive approval is needed.
export function decideAuto(
  req: PermissionRequest,
  mode: PermissionMode,
  allowlist: string[],
): AutoDecision {
  // Read-only mode allows network reads but no mutations or shell.
  if (mode === "plan") return req.kind === "fetch" ? "ask" : "deny";
  if (mode === "bypass") return "allow";
  // Guarded files always surface a prompt, even under acceptEdits or the allowlist.
  if (req.protected) return "ask";
  if (req.kind === "bash" && isAllowlisted(req.detail, allowlist)) return "allow";
  if (mode === "acceptEdits" && (req.kind === "write" || req.kind === "edit")) return "allow";
  return "ask";
}
