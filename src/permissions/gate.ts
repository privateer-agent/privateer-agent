// Permission-gate vocabulary — the request shape the policy reasons about, and
// the decision it returns. Ported from tree-cli/src/permissions/gate.ts, trimmed
// to types only: in the 0.2 codebase each tool built a PermissionRequest and
// called ctx.gate.request(); in the Pi rewrite the gate is a `tool_call`
// extension hook that receives { toolName, input } and derives the request via
// classifyToolCall (see ./classify.ts). So the pass-through gate is gone; the
// live policy lives in ./mode.ts + ./modeGate.ts.

export type PermissionDecision = "allow" | "deny";

// "computer" is GUI control — a click, a keystroke, a screenshot (src/tools/computer.ts).
// It is its own kind rather than a flavour of bash or write because nothing else here
// describes it: there is no path to scope, no command for the denylist to read, and the
// action reaches outside every limit the other kinds enforce (a mouse can open a
// terminal and type what danger.ts would have caught, or click Allow on another
// application's dialog). ./mode.ts gives it the only policy that makes sense for
// something a classifier cannot inspect — it never auto-approves, in any mode.
export type PermissionKind = "write" | "edit" | "bash" | "fetch" | "read" | "computer";

/**
 * What the human is being asked to look at, for a GUI action.
 *
 * WHY THIS IS PART OF THE REQUEST AND NOT A UI DETAIL. Every other permission prompt
 * describes something a person can evaluate from words: a path, a command, a URL. A
 * click cannot be. "Click at 812,344" is not a decision — it is a dialog people learn to
 * tap through, which makes the gate that is the ENTIRE safety mechanism for screen
 * control (permissions/mode.ts never auto-approves it) worth nothing. So the frame the
 * model was looking at, and the point it is aiming at, travel WITH the request.
 *
 * Coordinates are in AGENT space — the grid of that screenshot — and are given
 * alongside the frame's own dimensions so a renderer can place the marker as a
 * FRACTION. That keeps it correct at whatever size the dialog happens to draw the
 * picture, on a phone or a desktop, without the UI needing to know anything about
 * device pixels or display scale.
 *
 * Optional throughout: a preview that could not be produced (no capture yet this
 * session, a helper that does not send one, a frame too large to relay) must degrade to
 * the text-only prompt rather than blocking the approval.
 */
export interface ApprovalPreview {
  /** The last frame the model was shown of the display this action targets. */
  image?: {
    /** base64 PNG, downscaled for the dialog — not the full frame the model received. */
    data: string;
    /** The preview image's own size. */
    width: number;
    height: number;
    /** The AGENT-space size the coordinates below are in. */
    frameWidth: number;
    frameHeight: number;
  };
  /** Where the action lands, in agent space. */
  target?: { x: number; y: number };
  /** A drag's destination, same space. */
  to?: { x: number; y: number };
  /** click / drag / scroll / move — lets the renderer draw the right marker. */
  action?: string;
}

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
  /**
   * For `kind: "computer"` only — the picture the decision is actually about. Attached
   * by the gate extension from the session's preview sink (computer/preview.ts), never
   * by classifyToolCall, which sees only {toolName, input} and has no way to reach a
   * screenshot.
   */
  preview?: ApprovalPreview;
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
