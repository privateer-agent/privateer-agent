// The permission gate — the safe-by-default moat, as a Pi extension.
//
// Phase 2. Ties together the ported policy: a `tool_call` hook classifies the
// call (./…/classify.ts), runs it through the ModeGate policy engine
// (./…/modeGate.ts → decideAuto), and blocks the tool when the decision is deny.
// The gate SUSPENDS the turn while an approval is pending (spike-B proven), routes
// to a LOCAL prompt (ctx.ui) or a REMOTE approver (the relay, Phase 4), and is
// FAIL-CLOSED: any throw, timeout, or abort blocks the tool. A `tool_result` hook
// redacts secrets from output before it reaches the model / relay.
//
// The load-bearing decision path is `decideToolCall`, kept pure and Pi-free so the
// ported tests exercise it without a live session.

import type { PermissionMode } from "../config/permissionMode.ts";
import type { PermissionRequest } from "../permissions/gate.ts";
import { ModeGate, type AskOutcome } from "../permissions/modeGate.ts";
import { classifyToolCall } from "../permissions/classify.ts";
import { redactText } from "../util/redact.ts";
import { DEFAULT_DENYLIST } from "../permissions/danger.ts";

// The per-tool_call hook context we read (structural subset of Pi's ctx — kept
// local so the gate stays import-order-safe and unit-testable).
export interface ToolCallCtx {
  signal?: AbortSignal;
  hasUI?: boolean;
  mode?: "tui" | "rpc" | "json" | "print" | string;
  // Pi's ExtensionUIContext shape (verified against pi-coding-agent 0.80):
  // select(title, options: string[]) → chosen string | undefined; confirm(title, message).
  ui?: {
    select?: (title: string, options: string[], opts?: unknown) => Promise<string | undefined>;
    confirm?: (title: string, message: string, opts?: unknown) => Promise<boolean>;
  };
}

// Session-scoped state + askers. Mutable fields (mode/allowlist/allowedOutsideRoots)
// persist across tool_calls; the askers are invoked per call.
export interface GateController {
  getMode(): PermissionMode;
  setMode(mode: PermissionMode): void;
  allowlist: string[];
  allowedOutsideRoots: string[];
  denylist?: string[];
  cwd: string;
  confineToCwd?: boolean;
  getRemote?(): boolean;
  getNoQuarter?(): boolean;
  // Total bypass — see ModeGate.getSkipAllPermissions. Set by the `--no-quarter`
  // launch flag (env PRIVATEER_NO_QUARTER); when true the gate auto-allows every
  // action with no prompt.
  getSkipAllPermissions?(): boolean;
  // Block a tool outright while the turn is remote-driven (only consulted when
  // getRemote() is true). For tools whose own prompts render on the host terminal
  // rather than the relay — e.g. pi-subagents — so a driven turn can't wedge on an
  // invisible local prompt. Returns true to block. See isRemoteUnsafeTool.
  blockedWhenRemote?(toolName: string): boolean;
  // Notified when blockedWhenRemote blocked a tool, so the controller can surface a
  // one-line reason in the app feed (a `notice` frame) explaining why nothing ran.
  onRemoteBlocked?(toolName: string): void;
  // Local interactive approval via the per-call ctx. Default provided below.
  localAsk(req: PermissionRequest, ctx: ToolCallCtx): Promise<AskOutcome>;
  // Remote (relay) approval. Optional until Phase 4; when absent, a remote turn
  // falls back to localAsk.
  remoteAsk?(req: PermissionRequest, signal?: AbortSignal): Promise<AskOutcome>;
  // Secret redactor for tool output. Defaults to redactText.
  redact?(text: string): string;
  // Hard ceiling on waiting for a decision before failing closed.
  approvalTimeoutMs?: number;
}

export interface GateBlock {
  block: true;
  reason: string;
}

// Tools that CANNOT be driven from the app and so are blocked outright on a
// remote-driven turn (see chat.ts wiring). pi-subagents runs each subagent as a
// child session/subprocess whose own permission gate + UI aren't wired to the
// relay — its approvals and "TUI clarification" prompts surface on the HOST
// terminal, never in the app. A driven turn that spawned one would wedge on a
// prompt the phone can't answer. `contact_supervisor`/`intercom` are the child→
// parent tools; they only exist in child sessions but are listed for safety.
// Blocking is fail-closed and matches the "remote turns never auto-approve"
// posture: the feature is simply disabled while driving until its prompts relay.
export const REMOTE_UNSAFE_TOOLS: ReadonlySet<string> = new Set([
  "subagent",
  "contact_supervisor",
  "intercom",
]);

export const isRemoteUnsafeTool = (toolName: string): boolean => REMOTE_UNSAFE_TOOLS.has(toolName);

// THE decision path. Classify → policy → decision, fail-closed on any error.
// Returns a block directive to deny, or undefined to let the tool run.
export async function decideToolCall(
  ctrl: GateController,
  toolName: string,
  input: unknown,
  ctx: ToolCallCtx,
): Promise<GateBlock | undefined> {
  // Remote-driven turn: a few tools can't be driven from the app because their own
  // interactive prompts render on the host terminal, not the relay (pi-subagents
  // spawns child sessions outside the bridge). Block them fail-closed BEFORE any
  // classification so a driven turn never wedges on a prompt the phone can't answer,
  // and tell the controller so it can post a notice to the app feed.
  if (ctrl.getRemote?.() && ctrl.blockedWhenRemote?.(toolName)) {
    ctrl.onRemoteBlocked?.(toolName);
    return {
      block: true,
      reason: `${toolName} is unavailable while this terminal is driven remotely — its prompts can't reach the app. Complete the task without it, or ask the operator to run it from the terminal directly.`,
    };
  }

  const req = classifyToolCall(toolName, input, {
    cwd: ctrl.cwd,
    confineToCwd: ctrl.confineToCwd,
    allowedOutsideRoots: ctrl.allowedOutsideRoots,
  });
  if (!req) return undefined; // no gate needed — read-only/in-scope/meta

  // Route the ask: a remote-driven turn goes to the relay approver (if wired),
  // otherwise the local UI. ModeGate decides *whether* to ask; this decides *who*.
  const ask = (r: PermissionRequest): Promise<AskOutcome> =>
    ctrl.getRemote?.() && ctrl.remoteAsk
      ? ctrl.remoteAsk(r, ctx.signal)
      : ctrl.localAsk(r, ctx);

  const gate = new ModeGate({
    getMode: ctrl.getMode,
    setMode: ctrl.setMode,
    allowlist: ctrl.allowlist,
    allowedOutsideRoots: ctrl.allowedOutsideRoots,
    // Default to the built-in dangerous-command patterns so bypass / no-quarter /
    // headless-subagent runs still force dangerous shell + secret-exfil to "ask"
    // (→ headless deny). A controller can extend, but never silently disable, this.
    denylist: ctrl.denylist ?? DEFAULT_DENYLIST,
    ask,
    getRemote: ctrl.getRemote,
    getNoQuarter: ctrl.getNoQuarter,
    getSkipAllPermissions: ctrl.getSkipAllPermissions,
  });

  let decision: "allow" | "deny";
  try {
    decision = await withTimeout(gate.request(req), ctrl.approvalTimeoutMs, ctx.signal);
  } catch (err) {
    // Fail closed: a thrown/aborted/timed-out approval blocks the tool. Phrase it
    // as terminal — re-issuing the identical call will hit the same closed gate, so
    // tell the model to stop retrying and take a different path (or ask the user).
    return {
      block: true,
      reason: `Approval unavailable (${(err as Error)?.message ?? "error"}) — blocked by default. Do not retry the same command; it will be blocked again. Try a different approach or ask the user to run it.`,
    };
  }
  if (decision === "deny") {
    return {
      block: true,
      reason: `${req.title} was denied by the permission gate. Do not retry the same command; it will be denied again. Take a different approach or ask the user to run it themselves.`,
    };
  }
  return undefined;
}

// Default local asker: prompt via ctx.ui when a UI is present; fail closed
// (deny) when headless (no UI) — the gate is the real safety, never auto-trust.
// TODO(verify) the exact ctx.ui.select/confirm API shape against Pi when the TUI
// is wired (Phase 6); coded defensively for now.
const ALLOW_ONCE = "Allow once";
const ALLOW_ALWAYS = "Allow and remember";
const DENY = "Deny";

export async function defaultLocalAsk(req: PermissionRequest, ctx: ToolCallCtx): Promise<AskOutcome> {
  if (!ctx.hasUI || !ctx.ui) return "deny"; // headless → fail closed
  const title = `${req.title}: ${req.detail}`;
  if (typeof ctx.ui.select === "function") {
    const choice = await ctx.ui.select(title, [ALLOW_ONCE, ALLOW_ALWAYS, DENY]);
    if (choice === ALLOW_ONCE) return "allow";
    if (choice === ALLOW_ALWAYS) return "always";
    return "deny"; // Deny, or cancel (undefined)
  }
  if (typeof ctx.ui.confirm === "function") {
    return (await ctx.ui.confirm("Permission", title)) ? "allow" : "deny";
  }
  return "deny";
}

// Build the extension factory. Pass to DefaultResourceLoader({ extensionFactories }).
export function makePermissionGate(ctrl: GateController) {
  const redact = ctrl.redact ?? redactText;
  if (!ctrl.localAsk) ctrl.localAsk = defaultLocalAsk;

  // Structural view of the Pi extension API surface we use (documented at
  // pi.dev/docs/latest/extensions).
  interface PiExtensionApi {
    on(
      event: "tool_call",
      handler: (
        event: { toolName: string; toolCallId: string; input: unknown },
        ctx: ToolCallCtx,
      ) => Promise<GateBlock | undefined>,
    ): void;
    on(
      event: "tool_result",
      handler: (
        event: {
          toolName: string;
          toolCallId: string;
          content: Array<{ type: string; text?: string; [k: string]: unknown }>;
          details?: unknown;
          isError?: boolean;
        },
        ctx: unknown,
      ) => { content?: unknown[] } | undefined,
    ): void;
  }

  return function permissionGate(pi: PiExtensionApi): void {
    pi.on("tool_call", (event, ctx) => decideToolCall(ctrl, event.toolName, event.input, ctx));

    // Redact secrets from tool output before it reaches the model / relay.
    // tool_result delivers content PARTS (per the Pi extension contract), not a
    // bare string — patch text parts and return a partial { content }; omitted
    // fields keep their current values.
    pi.on("tool_result", (event) => {
      let touched = false;
      const content = event.content.map((part) => {
        if (typeof part.text === "string") {
          const red = redact(part.text);
          if (red !== part.text) touched = true;
          return { ...part, text: red };
        }
        return part;
      });
      return touched ? { content } : undefined;
    });
  };
}

function withTimeout<T>(p: Promise<T>, ms: number | undefined, signal?: AbortSignal): Promise<T> {
  if (!ms && !signal) return p;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (ms) timer = setTimeout(() => reject(new Error("approval timeout")), ms);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    p.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
