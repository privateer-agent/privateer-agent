import type { PermissionMode } from "../config/schema.ts";
import type { PermissionGate, PermissionRequest, PermissionDecision } from "./gate.ts";
import { decideAuto } from "./mode.ts";
import { isDangerousCommand } from "./danger.ts";

// What the interactive prompt can return. "always" means allow now and remember:
// for bash, add the command to the session allowlist; for edits, switch to acceptEdits.
export type AskOutcome = "allow" | "deny" | "always";
export type Asker = (req: PermissionRequest) => Promise<AskOutcome>;

export interface ModeGateDeps {
  getMode: () => PermissionMode;
  setMode: (mode: PermissionMode) => void;
  allowlist: string[]; // session-scoped, mutated in place on "always"
  denylist?: string[]; // dangerous-command patterns that always require a prompt
  ask: Asker;
}

// The permission gate used by the live TUI. It first applies the mode/allowlist
// policy; only when that yields "ask" does it surface an interactive prompt, and it
// applies "always" outcomes so subsequent similar actions don't re-prompt.
export class ModeGate implements PermissionGate {
  constructor(private readonly deps: ModeGateDeps) {}

  async request(req: PermissionRequest): Promise<PermissionDecision> {
    const denylist = this.deps.denylist ?? [];
    const auto = decideAuto(req, this.deps.getMode(), this.deps.allowlist, denylist);
    if (auto !== "ask") return auto;

    // A dangerous command can be approved once, but is never remembered: adding
    // it to the allowlist would let a later injected variant slip through.
    const dangerous = req.kind === "bash" && isDangerousCommand(req.detail, denylist);

    const outcome = await this.deps.ask(req);
    if (outcome === "deny") return "deny";
    if (outcome === "always" && !dangerous) {
      if (req.kind === "bash") {
        if (!this.deps.allowlist.includes(req.detail)) this.deps.allowlist.push(req.detail);
      } else {
        this.deps.setMode("acceptEdits");
      }
    }
    return "allow";
  }
}
