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

// Persistent footer indicator for remote access. When the relay is up, the footer
// shows a GREEN "⟿ remote access" line so it's always obvious this terminal can be
// driven from the phone — with a reminder that `/remote-access off` stops it. We
// keep a UI handle (captured from session_start / the command ctx) so the relay's
// own connect/disconnect callbacks can refresh the indicator, not just the command.
const GREEN = "\x1b[32m", YELLOW = "\x1b[33m", DIM = "\x1b[2m", RESET = "\x1b[0m";
const REMOTE_STATUS_KEY = "privateer:remote-access";
let uiRef: any = null;
// "off" → no indicator; "connecting" → relay starting or reconnecting (yellow);
// "connected" → socket open, controller reachable (green).
let remoteState: "off" | "connecting" | "connected" = "off";

function refreshRemoteStatus(): void {
  const ui = uiRef;
  if (!ui?.setStatus) return;
  if (remoteState === "off") {
    ui.setStatus(REMOTE_STATUS_KEY, undefined);
    return;
  }
  const text =
    remoteState === "connected"
      ? `${GREEN}⟿ remote access${RESET} ${DIM}· /remote-access off to stop${RESET}`
      : `${YELLOW}⟿ remote access · connecting…${RESET} ${DIM}· /remote-access off to stop${RESET}`;
  ui.setStatus(REMOTE_STATUS_KEY, text);
}

function setRemoteState(s: typeof remoteState): void {
  remoteState = s;
  refreshRemoteStatus();
}

// Tear down the relay and clear the indicator. Used by `/remote-access off` AND by
// the app's own "End remote access" action (onTerminate), so both paths converge.
function disableRemote(): void {
  relay?.stop();
  relay = null;
  setRemoteState("off");
}

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
  // The app asked to end remote access from its side — stop the relay locally too so
  // the terminal doesn't keep reconnecting, and clear the green indicator.
  onTerminate: () => disableRemote(),
  onControllerAttached: () => {
    // A controller reached us → the socket is up and driving: go green.
    setRemoteState("connected");
    relay?.sendSnapshot([{ kind: "notice", text: "Privateer terminal connected." }]);
  },
  onAttachment: (file) => sinceLastPrompt.push(attachments.register(file)),
  // Drive the indicator from the relay's own status stream: "connected" → green;
  // its reconnect/retry notices → yellow "connecting…". Ignored once we're off.
  onStatus: (text) => {
    if (!relay) return;
    if (/disconnect|reconnect|retry|couldn't|could not/i.test(text)) setRemoteState("connecting");
    else if (/connected/i.test(text)) setRemoteState("connected");
  },
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
    // Capture the UI handle so the relay's connect/disconnect callbacks can refresh
    // the footer indicator (they fire outside any command's ctx). Re-render in case
    // remote access was already on when the session (re)started.
    if (ctx?.ui) uiRef = ctx.ui;
    refreshRemoteStatus();
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
      if (ctx?.ui) uiRef = ctx.ui; // keep the handle fresh for relay-driven refreshes
      const off = String(args ?? "").trim().toLowerCase() === "off";
      if (off) {
        disableRemote();
        return ctx.ui?.notify?.("remote access off", "info");
      }
      if (relay) return ctx.ui?.notify?.("remote access already on", "info");
      if (!priv.hasCredentials()) return ctx.ui?.notify?.("Not signed in to Privateer.", "warning");
      relay = new RelayClient(bridge.callbacks, { label: "privateer-cli" });
      bridge.attachRelay(relay);
      setRemoteState("connecting"); // yellow until the relay reports connected
      await relay.start();
      ctx.ui?.notify?.("Remote access on — approve this terminal in the Privateer app, then drive it from there.", "info");
    },
  });
}
