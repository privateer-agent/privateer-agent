// Adapters that connect the subagent approval channel (src/remote/subagentChannel.ts)
// to the two ends that use it:
//
//   • CHILD side — makeChildGateAsk(): an `Asker` the discovered permission-gate uses
//     as its `localAsk` when running inside a subagent child. Instead of denying a
//     gated action headlessly, it forwards the approval to the parent and maps the
//     reply to an AskOutcome. Fail-closed: no channel / timeout / deny → "deny".
//
//   • PARENT side — startParentApprovalRelay(): a top-level privateer session ensures
//     the channel dir, advertises it to descendants via env, and watches it — relaying
//     each child ask to the app over its RemoteBridge (remoteAsk / selectRemote /
//     inputRemote) and writing the answer back. When no controller is attached the
//     bridge's own fail-closed posture denies, so an undriven terminal never
//     auto-approves a subagent's gated action.
//
// The channel dir is per ROOT parent and inherited by every (nested) descendant, so
// an approval raised at any subagent depth reaches the one session that holds the app
// relay. A subagent child never starts its own watcher — it only forwards.

import type { PermissionRequest } from "../permissions/gate.ts";
import type { AskOutcome, Asker } from "../permissions/modeGate.ts";
import type { SelectRequest, InputRequest } from "./remoteBridge.ts";
import {
  askParent,
  watchSubagentChannel,
  ensureChannelDir,
  channelDirForSession,
  SUBAGENT_CHANNEL_ENV,
  type SubagentAsk,
  type SubagentReply,
  type WatcherHandle,
} from "./subagentChannel.ts";
import { randomUUID } from "node:crypto";

// True when this process IS a subagent child (pi-subagents sets PI_SUBAGENT_CHILD=1).
export function isSubagentChild(): boolean {
  return process.env.PI_SUBAGENT_CHILD === "1";
}

// The channel dir advertised to this process (set by the root parent, inherited by
// every child through the environment). Undefined → no relay wired → fail closed.
export function inheritedChannelDir(): string | undefined {
  const d = process.env[SUBAGENT_CHANNEL_ENV]?.trim();
  return d || undefined;
}

// This subagent's role name (for display/audit on the parent), best-effort from env.
function childAgentName(): string | undefined {
  return process.env.PI_SUBAGENT_CHILD_AGENT?.trim() || undefined;
}

// ── child side ───────────────────────────────────────────────────────────────

// Build the `localAsk` a subagent child's gate should use: forward the approval to
// the parent over the inherited channel. A child NEVER returns "always" (it must not
// mutate the human's allowlist/mode); only "allow"/"deny". If no channel is wired,
// or the parent doesn't answer, it denies — the same fail-closed stance as a headless
// gate with no UI.
export function makeChildGateAsk(dir: string): Asker {
  const agent = childAgentName();
  return async (req: PermissionRequest): Promise<AskOutcome> => {
    const ask: SubagentAsk = { type: "approval", kind: req.kind, title: req.title, detail: req.detail };
    const reply = await askParent(dir, ask, { agent });
    return reply?.decision === "allow" ? "allow" : "deny";
  };
}

// ── parent side ──────────────────────────────────────────────────────────────

// The subset of RemoteBridge the parent relay needs. RemoteBridge implements it.
export interface ApprovalRelayBridge {
  isConnected(): boolean;
  remoteAsk(req: PermissionRequest, signal?: AbortSignal): Promise<AskOutcome>;
  selectRemote(req: SelectRequest, signal?: AbortSignal): Promise<string | null>;
  inputRemote(req: InputRequest, signal?: AbortSignal): Promise<string | null>;
}

// Map one child ask to the app over the bridge and return the reply. When no
// controller is attached the bridge fails closed (remoteAsk→"deny", select/input→
// null), so an undriven terminal denies a subagent's gated action rather than
// auto-approving it.
export async function relayAskToApp(bridge: ApprovalRelayBridge, ask: SubagentAsk): Promise<SubagentReply> {
  switch (ask.type) {
    case "approval": {
      const outcome = await bridge.remoteAsk({
        tool: "subagent",
        kind: (ask.kind as PermissionRequest["kind"]) ?? "bash",
        title: ask.title,
        detail: ask.detail,
      });
      return { decision: outcome === "deny" ? "deny" : "allow" };
    }
    case "select": {
      const value = await bridge.selectRemote({ title: ask.title, options: ask.options, current: ask.current });
      return { value };
    }
    case "input": {
      const value = await bridge.inputRemote({ title: ask.title, placeholder: ask.placeholder });
      return { value };
    }
  }
}

export interface ParentRelayHandle extends WatcherHandle {
  dir: string;
}

// Start the parent-side approval relay for a top-level session. Ensures the channel
// dir, advertises it to descendants via SUBAGENT_CHANNEL_ENV (only if not already
// set — a nested privateer session, which shouldn't happen, must not clobber the
// root's), and watches it, relaying each ask to the app over `bridge`. Returns a
// handle whose stop() ends the watcher (call on session teardown).
//
// No-op-ish for a subagent child: a child must never watch (it has no app relay) — it
// only forwards. Callers are top-level sessions, but this guards anyway.
export function startParentApprovalRelay(
  bridge: ApprovalRelayBridge,
  opts: { onError?: (err: unknown) => void } = {},
): ParentRelayHandle | null {
  if (isSubagentChild()) return null;
  const dir = inheritedChannelDir() ?? channelDirForSession(`${process.pid}-${randomUUID()}`);
  process.env[SUBAGENT_CHANNEL_ENV] = dir; // advertise to children spawned after this
  ensureChannelDir(dir);
  const watcher = watchSubagentChannel(dir, (ask) => relayAskToApp(bridge, ask), { onError: opts.onError });
  return { dir, stop: watcher.stop };
}
