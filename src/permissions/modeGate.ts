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
  // turns auto-approve so the agent runs to completion without pinging the phone.
  // This is the SAME total bypass as the `--no-quarter` launch flag below, only
  // scoped to remote turns — dangerous shell, secret-exfil shapes and alwaysAsk-
  // destructive tools included. It has to be: "no quarter" is a step-away-from-
  // the-keyboard switch, and a mode that still stops on the one command the user
  // walked away from isn't unattended, it's a turn that wedges until it times out
  // (a relayed prompt with nobody to answer it fails closed). A hard "deny" — plan
  // mode — is still honored, so a read-only stance can't be talked around remotely.
  getNoQuarter?: () => boolean;
  // True while a non-interactive runtime is running under its "auto" posture (the
  // ACP host's `posture: "auto"`, a channel whose role resolves to it). Weaker than
  // no-quarter on purpose: re-decide as if in bypass mode, so ordinary writes and
  // bash run unattended but dangerous shell / alwaysAsk-destructive actions still
  // relay for an explicit Allow/Deny. The party choosing it there is a host config
  // or a chat-app role, not someone who tapped through a confirm on their own
  // terminal, so it does not get to clear the denylist.
  getAutoApprove?: () => boolean;
  // True when the operator launched with `--no-quarter` (env PRIVATEER_NO_QUARTER):
  // a session-wide TOTAL bypass of the gate. Every request auto-approves — including
  // dangerous shell, destructive tools, out-of-cwd and protected-file access — with
  // no prompt, local or remote. This sits ABOVE everything else (mode, allowlist,
  // the remote branch, even the dangerous-command denylist): the operator has
  // explicitly opted the whole session out of the moat. Off unless the flag is set.
  getSkipAllPermissions?: () => boolean;
  // Spend the operator authorized IN ADVANCE, by tool name, at a moment when there WAS
  // a human to ask: the media tools a routine names when it is saved (naming them is
  // itself the decision — they are deliberately absent from the default allow-list, and
  // saving a routine that grants egress is an alwaysAsk prompt of its own), handed to
  // the run that fires hours later with nobody watching.
  //
  // Consulted ONLY to lift `alwaysAsk`, and only under the guards in ModeGate.request.
  // Absent ⇒ nothing is pre-authorized, which is the posture every interactive session
  // keeps: a terminal always asks its human, however cheap the call.
  isSpendPreauthorized?: (req: PermissionRequest) => boolean;
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
      // No-quarter: the controller has lowered the moat for this session, so
      // auto-allow everything the plan-mode deny above didn't already stop —
      // dangerous shell and alwaysAsk-destructive tools included. Stronger than
      // `/mode bypass` (which keeps those two above it) and deliberately so: it
      // is the remote-scoped twin of the `--no-quarter` flag, and the app's
      // confirm says as much before the flag goes up.
      if (this.deps.getNoQuarter?.()) return "allow";
      // "auto" posture: the weaker cousin — bypass-equivalent, with dangerous and
      // alwaysAsk-destructive actions still falling through to the relayed prompt.
      if (this.deps.getAutoApprove?.() && decideAuto(req, "bypass", this.deps.allowlist, denylist) === "allow") {
        return "allow";
      }
      return (await this.deps.ask(req)) === "deny" ? "deny" : "allow";
    }

    if (auto !== "ask") return auto;

    // Pre-authorized spend. An unattended run reaches here with no one to ask, so an
    // `alwaysAsk` tool — every billing media tool — was denied outright: the harbor
    // let a routine NAME generate_video and then blocked every call it made, which is
    // not a safe default so much as a capability that silently didn't exist.
    //
    // This lifts that one veto, and only that one. Four guards, all load-bearing:
    //
    //   • the controller must vouch for THIS tool by name (the harbor passes the media
    //     tools this run's own allow-list names — see harbor/index.ts);
    //   • `alwaysAsk` must be the ONLY reason we're asking. Re-deciding with the flag
    //     cleared is how that is checked, so a pre-authorized tool in `plan` mode is
    //     still denied and one at the default mode still prompts — pre-authorization
    //     never grants what the mode wouldn't;
    //   • never when the call leaves the working directory or touches a protected file.
    //     bypass mode allows both outright, so this cannot lean on the re-decide above:
    //     "you may generate video" must not become "you may upload ~/.ssh/id_rsa as a
    //     reference image", which is exactly the shape classify.ts flags;
    //   • never on a remote-driven turn — that branch returned above. A driven turn has
    //     a human holding the phone, and they get the prompt.
    if (
      req.alwaysAsk &&
      !req.outside &&
      !req.protected &&
      this.deps.isSpendPreauthorized?.(req) === true &&
      decideAuto({ ...req, alwaysAsk: false }, this.deps.getMode(), this.deps.allowlist, denylist) === "allow"
    ) {
      return "allow";
    }

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
