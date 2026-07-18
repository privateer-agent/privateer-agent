import { dirname } from "node:path";
import type { PermissionMode } from "../config/permissionMode.ts";
import type { PermissionGate, PermissionRequest, PermissionDecision } from "./gate.ts";
import { decideAuto } from "./mode.ts";
import { isDangerousCommand } from "./danger.ts";

// Ported verbatim from tree-cli/src/permissions/uiGate.ts (renamed modeGate;
// only import paths changed). The mode/allowlist/remote policy engine — the moat.
// In the Pi rewrite the extension (../ext/permissionGate.ts) builds one of these
// per tool_call, with `ask` bound to that call's ctx.ui (local) or the relay (remote).

// What the interactive prompt can return. "always" means allow now and remember:
// for bash, add the command to the session allowlist; for edits, switch to acceptEdits.
export type AskOutcome = "allow" | "deny" | "always";
export type Asker = (req: PermissionRequest) => Promise<AskOutcome>;

export interface ModeGateDeps {
  getMode: () => PermissionMode;
  setMode: (mode: PermissionMode) => void;
  allowlist: string[]; // session-scoped, mutated in place on "always"
  denylist?: string[]; // dangerous-command patterns that always require a prompt
  // Out-of-cwd directories approved this session ("always" on an outside prompt),
  // mutated in place. Shared with the tool scope so approved locations stop re-prompting.
  allowedOutsideRoots?: string[];
  ask: Asker;
  // True while the active turn was injected by a remote controller (the app, via
  // /remote-access). Remote turns NEVER auto-approve off bypass-mode/allowlist/
  // acceptEdits — every would-be action is relayed to the app for Allow/Deny, so
  // an unattended terminal can't silently run a remote party's bash or edits.
  // Hard denies (e.g. plan mode) are still honored without bothering the phone.
  getRemote?: () => boolean;
  // True while the controller has toggled no-quarter (unattended) mode: remote
  // turns auto-approve like bypass mode so the agent runs to completion without
  // pinging the phone. Dangerous shell and alwaysAsk-destructive actions rank
  // above bypass in decideAuto, so those still relay for an explicit Allow/Deny.
  getNoQuarter?: () => boolean;
  // True when the operator launched with `--no-quarter` (env PRIVATEER_NO_QUARTER):
  // a session-wide TOTAL bypass of the gate. Every request auto-approves — including
  // dangerous shell, destructive tools, out-of-cwd and protected-file access — with
  // no prompt, local or remote. This sits ABOVE everything else (mode, allowlist,
  // the remote branch, even the dangerous-command denylist): the operator has
  // explicitly opted the whole session out of the moat. Off unless the flag is set.
  getSkipAllPermissions?: () => boolean;
}

// The permission gate used by the live TUI. It first applies the mode/allowlist
// policy; only when that yields "ask" does it surface an interactive prompt, and it
// applies "always" outcomes so subsequent similar actions don't re-prompt.
export class ModeGate implements PermissionGate {
  constructor(private readonly deps: ModeGateDeps) {}

  async request(req: PermissionRequest): Promise<PermissionDecision> {
    // No-quarter: the operator launched with `--no-quarter`, opting the whole
    // session out of the gate. Total bypass — auto-allow EVERY request (dangerous
    // shell, destructive tools, outside-cwd, protected files) with no prompt, before
    // any mode/allowlist/remote/denylist policy is consulted. Deliberately the very
    // first check so nothing below can force an "ask" back on.
    if (this.deps.getSkipAllPermissions?.()) return "allow";

    const denylist = this.deps.denylist ?? [];
    const auto = decideAuto(req, this.deps.getMode(), this.deps.allowlist, denylist);

    // Remote-driven turn: skip every auto-allow (bypass/allowlist/acceptEdits) and
    // relay the decision to the app. Still respect a hard "deny" (e.g. plan mode)
    // so a read-only stance can't be talked around remotely. Outcomes are never
    // remembered — we don't let a remote operator mutate local allowlist/mode.
    if (this.deps.getRemote?.()) {
      if (auto === "deny") return "deny";
      // No-quarter: re-evaluate as if in bypass mode. Dangerous/destructive
      // actions still come back "ask" (they sit above bypass) and fall through
      // to the relayed prompt; everything else runs unattended.
      if (this.deps.getNoQuarter?.() && decideAuto(req, "bypass", this.deps.allowlist, denylist) === "allow") {
        return "allow";
      }
      return (await this.deps.ask(req)) === "deny" ? "deny" : "allow";
    }

    if (auto !== "ask") return auto;

    // A dangerous command (or an always-ask destructive action) can be approved
    // once, but is never remembered: adding it to the allowlist or relaxing the
    // mode would let a later variant slip through.
    const dangerous = req.alwaysAsk === true || (req.kind === "bash" && isDangerousCommand(req.detail, denylist));

    const outcome = await this.deps.ask(req);
    if (outcome === "deny") return "deny";
    if (outcome === "always" && !dangerous) {
      if (req.outside) {
        // Remember the approved location's directory, so further access under it (a
        // sibling repo the user pointed us at) doesn't re-prompt. Deliberately does
        // NOT relax the edit mode — leaving cwd stays a per-location decision.
        const roots = this.deps.allowedOutsideRoots;
        const root = req.path ? dirname(req.path) : undefined;
        if (roots && root && !roots.includes(root)) roots.push(root);
      } else if (req.kind === "bash") {
        if (!this.deps.allowlist.includes(req.detail)) this.deps.allowlist.push(req.detail);
      } else {
        this.deps.setMode("acceptEdits");
      }
    }
    return "allow";
  }
}
