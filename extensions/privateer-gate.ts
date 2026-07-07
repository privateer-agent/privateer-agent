// The Privateer control extension for Pi's TUI (Phase 6): the permission gate PLUS
// remote access, so the app can drive the real TUI (not just the lean REPL).
//
//   - gate: tool_call → block/allow via Pi's native approval UI (ctx.ui); /mode command.
//   - remote access: /remote-access on connects the relay; the bridge routes the
//     gate's approvals to the phone (getRemote/remoteAsk) and drives turns from app
//     prompts (pi.sendUserMessage). Turn events forward to the app via the adapter —
//     the same pi.on(...) stream the adapter already speaks.
//
// The gate + bridge share one extension so the gate's remote branch and the relay
// are wired to the same state.

import { makePermissionGate, defaultLocalAsk } from "../src/ext/permissionGate.ts";
import { createEngineEventAdapter } from "../src/bridge/engineAdapter.ts";
import { RemoteBridge } from "../src/remote/remoteBridge.ts";
import { RelayClient } from "../src/remote/relayClient.ts";
import { makeSendFileTool } from "../src/tools/sendFile.ts";
import { makeSaveAttachmentTool } from "../src/tools/saveAttachment.ts";
import { AttachmentStore, type StoredAttachment } from "../src/util/attachmentStore.ts";
import * as priv from "../src/auth/privateer.ts";
import type { PermissionMode } from "../src/config/permissionMode.ts";

const MODES: PermissionMode[] = ["default", "acceptEdits", "bypass", "plan"];
let mode: PermissionMode = MODES.includes(process.env.PRIVATEER_MODE as PermissionMode)
  ? (process.env.PRIVATEER_MODE as PermissionMode)
  : "default";
const allowlist: string[] = [];
const allowedOutsideRoots: string[] = [];

let piRef: any = null;
let relay: any = null;

// Inbound app→CLI files land here (keyed by "#n"); save_attachment persists them.
const attachments = new AttachmentStore();
let sinceLastPrompt: StoredAttachment[] = [];

const bridge = new RemoteBridge({
  onPrompt: (text) => {
    // Fold any files the app sent since the last prompt into a reference note so the
    // model knows they exist and can save_attachment them.
    const atts = sinceLastPrompt;
    sinceLastPrompt = [];
    const note = atts.length
      ? `\n\n[Files attached from the app: ${atts.map((a) => `#${a.n} ${a.name} (${a.mediaType})`).join(", ")}. ` +
        `Use the save_attachment tool with the ref number to write one to disk.]`
      : "";
    piRef?.sendUserMessage?.(text + note); // drive a turn in Pi's TUI
  },
  onInterrupt: () => {}, // Pi owns interrupt; best-effort no-op
  onControllerAttached: () => relay?.sendSnapshot([{ kind: "notice", text: "Privateer terminal connected." }]),
  onAttachment: (file) => sinceLastPrompt.push(attachments.register(file)),
  onStatus: () => {},
});

const gate = makePermissionGate({
  getMode: () => mode,
  setMode: (m) => (mode = m),
  allowlist,
  allowedOutsideRoots,
  cwd: process.cwd(),
  localAsk: defaultLocalAsk,
  getRemote: bridge.getRemote,
  getNoQuarter: bridge.getNoQuarter,
  remoteAsk: bridge.remoteAsk,
});

export default function privateerControl(pi: any): void {
  piRef = pi;
  gate(pi); // tool_call (block/allow) + tool_result (redact)

  // File transfer both ways: send_file_to_client (CLI→app, via the bridge's relay) and
  // save_attachment (app→CLI, from the AttachmentStore inbound files land in). Both
  // live here because they share the RemoteBridge / its attachment stream.
  pi.registerTool?.(makeSendFileTool(bridge));
  pi.registerTool?.(makeSaveAttachmentTool(attachments));

  // Subagents (and print/rpc) run as headless child `pi` processes with no UI. There
  // no one can approve, so a "default" gate would fail-closed on every tool and the
  // subagent couldn't work. Instead switch to bypass: auto-approve within the agent's
  // OWN restricted tool set (pi-subagents' per-role `tools:` allowlist), while
  // decideAuto STILL forces dangerous shell / secret-exfil / destructive actions to
  // "ask" → headless → denied. So delegation is gated in the parent (the spawn tool
  // call), and the subagent is bounded by its role + danger detection. The TUI
  // (mode "tui") keeps the interactive default gate.
  // Explicit ALLOWLIST of headless run modes — never an "anything but tui" denylist,
  // so an unexpected/undefined mode in the interactive TUI can't silently drop us into
  // bypass (which would run tools ungated). Only switch when we're *sure* it's headless
  // and the user hasn't pinned a mode via PRIVATEER_MODE.
  const HEADLESS = new Set(["json", "print", "rpc"]);
  pi.on("session_start", (_e: any, ctx: any) => {
    if (ctx?.mode && HEADLESS.has(ctx.mode) && (process.env.PRIVATEER_MODE ?? "") === "") {
      mode = "bypass";
    }
  });

  // Forward turn events to the app. The relay only sends when a controller is
  // attached, so this is safe on every turn (local or remote).
  const adapter = createEngineEventAdapter();
  const fwd = (ev: any) => {
    for (const ee of adapter.toEngineEvents(ev)) bridge.forwardEvent(ee);
  };
  pi.on("message_update", (ev: any) => fwd(ev));
  pi.on("tool_execution_start", (ev: any) => fwd(ev));
  pi.on("tool_execution_end", (ev: any) => fwd(ev));
  pi.on("turn_end", (ev: any) => fwd(ev));
  // A remote-initiated agent run ends here → clear the remote flag so a later
  // locally-typed turn isn't treated as remote.
  pi.on("agent_end", (ev: any) => {
    fwd(ev);
    bridge.settleTurn();
  });

  pi.registerCommand?.("mode", {
    description: "Show or set the permission mode: default | acceptEdits | bypass | plan",
    handler: (args: string, ctx: any) => {
      const m = String(args ?? "").trim() as PermissionMode;
      if (m && MODES.includes(m)) mode = m;
      else if (m) return ctx.ui?.notify?.(`unknown mode "${m}" — use ${MODES.join(" | ")}`, "warning");
      ctx.ui?.notify?.(`permission mode: ${mode}`, "info");
    },
  });

  pi.registerCommand?.("remote-access", {
    description: "Drive this terminal from the Privateer app: /remote-access on | off",
    handler: async (args: string, ctx: any) => {
      const off = String(args ?? "").trim().toLowerCase() === "off";
      if (off) {
        relay?.stop();
        relay = null;
        return ctx.ui?.notify?.("remote access off", "info");
      }
      if (relay) return ctx.ui?.notify?.("remote access already on", "info");
      if (!priv.hasCredentials()) return ctx.ui?.notify?.("Not signed in to Privateer.", "warning");
      relay = new RelayClient(bridge.callbacks, { label: "privateer-cli" });
      bridge.attachRelay(relay);
      await relay.start();
      ctx.ui?.notify?.("Remote access on — approve this terminal in the Privateer app, then drive it from there.", "info");
    },
  });
}
