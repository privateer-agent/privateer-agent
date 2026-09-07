import type { PermissionMode } from "../config/permissionMode.ts";
import type { PermissionRequest } from "./gate.ts";
import { isDangerousCommand } from "./danger.ts";

// Ported verbatim from tree-cli/src/permissions/mode.ts (only the PermissionMode
// import path changed). This is the pure mode/allowlist policy the gate consults
// before ever involving the user.

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
  denylist: string[] = [],
): AutoDecision {
  // Read-only mode allows network reads but no mutations or shell.
  if (mode === "plan") return req.kind === "fetch" ? "ask" : "deny";
  // Dangerous shell (destructive / secret-exfil) always confirms — this sits
  // above bypass and the allowlist so an injected command can't run silently.
  if (req.kind === "bash" && isDangerousCommand(req.detail, denylist)) return "ask";
  // Explicitly destructive actions (e.g. a tool that declares destructiveHint)
  // always confirm too — also above bypass, so "skip permissions" can't fire them
  // blind.
  if (req.alwaysAsk) return "ask";
  // GUI control always confirms, above bypass and above the "auto" posture that
  // re-decides as bypass (modeGate.ts). Every other kind is auto-approvable because
  // something here can inspect it — a path against the scope, a command against the
  // denylist. A click has neither: {x, y} says nothing about whether it lands on
  // "Save" or on "Erase disk", and the thing it clicks may be another application's
  // permission dialog. Approving it therefore has to mean a human looked at the
  // screenshot, which means asking every time. The one lever above this is the
  // session-wide no-quarter bypass in ModeGate.request, and config/computerControl.ts
  // says out loud what arming plus no-quarter adds up to.
  if (req.kind === "computer") return "ask";
  if (mode === "bypass") return "allow";
  // Access outside the working directory always confirms (the user has to explicitly
  // allow leaving cwd), even under acceptEdits or the allowlist.
  if (req.outside) return "ask";
  // Guarded files always surface a prompt, even under acceptEdits or the allowlist.
  if (req.protected) return "ask";
  if (req.kind === "bash" && isAllowlisted(req.detail, allowlist)) return "allow";
  if (mode === "acceptEdits" && (req.kind === "write" || req.kind === "edit")) return "allow";
  return "ask";
}
