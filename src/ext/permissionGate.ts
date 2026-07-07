// The permission gate — the safe-by-default moat, as a Pi extension.
//
// Promoted from the inline gate in ../../ pi-spike/spike-b.mjs (spike-B proven:
// a `pi.on("tool_call")` handler SUSPENDS the turn while an approval round-trips,
// deny blocks the tool, allow lets it run). This is the Phase-2 skeleton; the
// full policy (tree-cli/src/permissions/{gate,danger,protected,mode,uiGate}.ts)
// ports into `decide` in Phase 2 — local path → ctx.ui, remote path → await the
// relay — per docs/pi-migration-plan.md §2 Phase 2.
//
// Fail-closed is the invariant: any throw, timeout, or missing decider blocks the
// tool. That is also Pi's own default, and we never weaken it.

export type PermissionDecision = "allow" | "deny";

export interface GateRequest {
  tool: string;
  input: unknown;
}

// Injected decision source. Phase 2 supplies two concrete deciders:
//   - local:  prompt via ctx.ui and return the user's choice
//   - remote: send an approval_request over RelayClient and await the response
// `signal` lets a hung remote approver be aborted so it can't wedge the turn.
export type Decider = (
  req: GateRequest,
  signal?: AbortSignal,
) => Promise<PermissionDecision>;

export interface GateOptions {
  decide: Decider;
  // Optional redactor applied to tool results before they leave the process
  // (ported from tree-cli/src/util/redact.ts in Phase 2). Identity by default.
  redact?: (text: string) => string;
  // Hard ceiling on how long we wait for a decision before failing closed.
  approvalTimeoutMs?: number;
}

// Minimal structural view of the Pi extension API this handler uses. Kept local
// (not a hard Pi import) so the gate stays import-order-safe and testable; the
// real types are asserted by the ported tests in Phase 2.
interface PiExtensionApi {
  on(
    event: "tool_call",
    handler: (
      event: { toolName: string; input: unknown },
      ctx: { signal?: AbortSignal },
    ) => Promise<{ block: true; reason: string } | undefined>,
  ): void;
  on(
    event: "tool_result",
    handler: (
      event: {
        toolName: string;
        toolCallId: string;
        // Content parts sent back to the model — NOT a bare string. The hook
        // returns a partial patch; omitted fields keep their current values.
        content: Array<{ type: string; text?: string; [k: string]: unknown }>;
        details?: unknown;
        isError?: boolean;
      },
      ctx: unknown,
    ) => { content?: unknown[] } | undefined,
  ): void;
}

// Build the extension factory. Usage: extensionFactories: [makePermissionGate({ decide })]
export function makePermissionGate(opts: GateOptions) {
  const { decide, redact = (t) => t, approvalTimeoutMs } = opts;

  return function permissionGate(pi: PiExtensionApi): void {
    pi.on("tool_call", async (event, ctx) => {
      let decision: PermissionDecision;
      try {
        decision = await withTimeout(
          decide({ tool: event.toolName, input: event.input }, ctx.signal),
          approvalTimeoutMs,
          ctx.signal,
        );
      } catch (err) {
        // Fail closed: a thrown decider, an abort, or a timeout blocks the tool.
        return {
          block: true,
          reason: `Approval unavailable (${(err as Error)?.message ?? "error"}) — blocked by default`,
        };
      }
      if (decision !== "allow") {
        return { block: true, reason: "Denied by permission gate" };
      }
      // allow → undefined lets execution proceed.
      return undefined;
    });

    // Redact secrets from tool output before it reaches the model / relay.
    // tool_result delivers content PARTS (per the Pi extension contract, doc:
    // /docs/latest/extensions), not a bare string — patch text parts and return
    // a partial { content }; omitted fields keep their current values. Phase 2
    // swaps `redact` for the real redactText.
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

function withTimeout<T>(
  p: Promise<T>,
  ms: number | undefined,
  signal?: AbortSignal,
): Promise<T> {
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
