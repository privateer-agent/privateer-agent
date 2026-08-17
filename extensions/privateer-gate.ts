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
import {
  isSubagentChild,
  inheritedChannelDir,
  makeChildGateAsk,
  startParentApprovalRelay,
} from "../src/remote/subagentRelay.ts";
import { RelayClient } from "../src/remote/relayClient.ts";
import { makeSendFileTool } from "../src/tools/sendFile.ts";
import { makeSaveAttachmentTool } from "../src/tools/saveAttachment.ts";
import { AttachmentStore, type StoredAttachment } from "../src/util/attachmentStore.ts";
import { makeExtensionsControl } from "../src/remote/extensionsControl.ts";
import { makeSkillsControl } from "../src/remote/skillsControl.ts";
import { agentDir } from "../src/config/paths.ts";
import { agentVersion } from "../src/config/version.ts";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import * as priv from "../src/auth/privateer.ts";
import { paletteFor } from "../src/ui/palette.ts";
import { noQuarterActive, setNoQuarter } from "../src/permissions/noQuarter.ts";
import { childSpendAllows } from "../src/permissions/childSpend.ts";
import type { PermissionMode } from "../src/config/permissionMode.ts";

const MODES: PermissionMode[] = ["default", "acceptEdits", "bypass", "plan"];
let mode: PermissionMode = MODES.includes(process.env.PRIVATEER_MODE as PermissionMode)
  ? (process.env.PRIVATEER_MODE as PermissionMode)
  : "default";
const allowlist: string[] = [];
const allowedOutsideRoots: string[] = [];

// A turn driven from the app is in flight. Guards the remote onPrompt path against a
// SECOND prompt arriving while Pi is still processing — which throws "Agent is already
// processing" and wedges the session. This happens in normal use when the app drops
// (backgrounded → socket suspended) and re-sends its prompt on reconnect. Mirrors the
// REPL's `turnActive` guard. Set on a successful sendUserMessage, cleared on agent_end.
let remoteTurnActive = false;

let piRef: any = null;
let relay: any = null;
// Pi-extension manager for the app's extensions screen. Built lazily on first use
// with a fresh SettingsManager (the ExtensionAPI exposes no package/settings manager),
// reading the same ~/.privateer/agent/settings.json Pi loads from.
let extensions: ReturnType<typeof makeExtensionsControl> | null = null;
function extControl(): ReturnType<typeof makeExtensionsControl> {
  if (!extensions) {
    const cwd = process.cwd();
    extensions = makeExtensionsControl({ cwd, agentDir: agentDir(), settingsManager: SettingsManager.create(cwd, agentDir()) });
  }
  return extensions;
}

// Run an extensions add/remove for the app and relay progress → result. The persist
// is immediate but the extension only loads on the next terminal launch, so the final
// frame flags needsRestart. (A live ctx.reload() is only reachable from the local
// /extensions command handler — not from a relay frame — see registerCommand below.)
async function runExtMutation(kind: "add" | "remove", source: string): Promise<void> {
  const ext = extControl();
  ext.setProgress((ev) =>
    relay?.sendExtensions({
      installed: ext.listInstalled(),
      busy: ev.type !== "complete" && ev.type !== "error",
      message: ev.message,
    }),
  );
  try {
    const res = kind === "add" ? await ext.add(source) : await ext.remove(source);
    relay?.sendExtensions({
      installed: ext.listInstalled(),
      message: res.ok
        ? `${kind === "add" ? "Added" : "Removed"} ${source} — restart the terminal to activate.`
        : res.message,
      needsRestart: res.ok,
    });
  } finally {
    ext.setProgress(undefined);
  }
}

// Skills manager for the app's skills screen. Built lazily like extControl(), with a
// fresh SettingsManager reading the same ~/.privateer/agent/settings.json Pi loads.
let skills: ReturnType<typeof makeSkillsControl> | null = null;
function skillControl(): ReturnType<typeof makeSkillsControl> {
  if (!skills) {
    const cwd = process.cwd();
    skills = makeSkillsControl({ cwd, agentDir: agentDir(), settingsManager: SettingsManager.create(cwd, agentDir()) });
  }
  return skills;
}

// Run a skills create/delete/toggle for the app and relay the fresh list + result.
// The write is immediate but only reaches the model's <available_skills> on the next
// launch (needsRestart); Run-now via /skill:name works without a restart.
async function runSkillMutation(op: () => Promise<{ ok: boolean; message?: string }>, verb: string): Promise<void> {
  const sk = skillControl();
  const res = await op();
  relay?.sendSkills({
    items: sk.listSkills(),
    message: res.ok ? `${verb} — restart the terminal to update the model's skill list.` : res.message,
    needsRestart: res.ok,
  });
}

// ── app-driven model switching (parity with the REPL's /model picker) ──────────
// The TUI's own /model command isn't reachable over the relay, so we reproduce it:
// the model registry + selected spec are captured from session_start / model_select,
// and currentSpec ("provider/id") follows both app- and locally-driven switches so
// the app's banner + picker always reflect what's actually selected.
let modelReg: any = null;
let currentSpec = "";

function modelSpec(m: any): string {
  return m ? `${m.provider}/${m.id}` : "";
}

// This machine's real model catalog as sorted "provider/id" specs — the same list
// the app's picker draws from (relayed on demand via /model, never pushed).
function availableModelSpecs(): string[] {
  const all: any[] = modelReg?.getAvailable ? modelReg.getAvailable() : [];
  return all.map(modelSpec).sort();
}

// Switch the live TUI model in place via Pi's setModel, then push context + a notice
// so the app's banner and feed follow. setModel returns false when no API key is
// configured for the target provider.
async function switchModelRemote(spec: string): Promise<void> {
  const sp = spec.trim();
  const at = sp.indexOf("/");
  if (at < 0) { relay?.sendNotice("Usage: /model provider/id"); return; }
  const p = sp.slice(0, at), id = sp.slice(at + 1);
  const model = modelReg?.find?.(p, id);
  if (!model) { relay?.sendNotice(`Model ${sp} not found — try /models.`); return; }
  try {
    const ok = await piRef?.setModel?.(model);
    if (ok === false) { relay?.sendNotice(`No API key for ${p} — can't switch to ${sp}.`); return; }
    currentSpec = sp;
    relay?.sendContext({ model: currentSpec, version: agentVersion() }); // banner follows
    relay?.sendNotice(`model → ${sp}`);
  } catch (e) {
    relay?.sendNotice(`Couldn't switch model: ${(e as Error).message}`);
  }
}

// The app /model picker: relay this machine's catalog as a selection prompt and
// switch to the driver's choice. Mirrors the REPL's pickModelRemote.
async function pickModelRemote(filter: string): Promise<void> {
  const specs = availableModelSpecs().filter((sp) => !filter || sp.toLowerCase().includes(filter));
  const choice = await bridge.selectRemote({
    title: "Choose a model",
    options: specs.map((sp) => ({ value: sp, label: sp })),
    current: currentSpec,
  });
  if (choice) await switchModelRemote(choice);
}

// Dispatch an app-composer slash command. The model/mode pickers are handled here
// (the TUI's native /model can't be reached over the relay); anything else is handed
// to Pi as a user message so extension/skill commands still run remotely — mirrors
// the REPL's runCommand fall-through.
async function runRemoteCommand(text: string): Promise<void> {
  const line = text.trim();
  // No quarter is a PHYSICAL-terminal action, like /remote-access. It's stronger than
  // any mode — it also switches off the dangerous-command denylist and the protected-
  // file guard — so a remote controller must not be able to reach it. (The app's own
  // no_quarter toggle covers driven turns: ModeGate re-decides those through
  // decideAuto(req, "bypass", …), so it IS /mode bypass — never weaker. Dangerous and
  // destructive actions sit above bypass, so they come back to the phone for an
  // explicit Allow there, exactly as bypass surfaces them locally.)
  if (line === "/no-quarter" || line.startsWith("/no-quarter ")) {
    relay?.sendNotice("/no-quarter is terminal-only — run it at the machine, or use the app's own no-quarter toggle.");
    return;
  }
  if (line.startsWith("/model ")) { await switchModelRemote(line.slice(7)); return; }
  if (line === "/model" || line === "/models" || line.startsWith("/models ")) {
    const filter = line.startsWith("/models ") ? line.slice(8).trim().toLowerCase() : "";
    await pickModelRemote(filter);
    return;
  }
  if (line.startsWith("/mode ")) {
    const m = line.slice(6).trim() as PermissionMode;
    if (MODES.includes(m)) { mode = m; relay?.sendNotice(`mode → ${mode}`); }
    else relay?.sendNotice(`unknown mode "${m}" — use ${MODES.join(" | ")}`);
    return;
  }
  if (line === "/mode") {
    const choice = await bridge.selectRemote({
      title: "Permission mode",
      options: MODES.map((v) => ({ value: v, label: v })),
      current: mode,
    });
    if (choice && MODES.includes(choice as PermissionMode)) { mode = choice as PermissionMode; relay?.sendNotice(`mode → ${mode}`); }
    return;
  }
  piRef?.sendUserMessage?.(line); // fall through: let Pi run it (or treat as a prompt)
}

// The slash commands to advertise to the app's composer: our built-in pickers plus
// whatever Pi has registered (extension/skill/template commands), deduped. Pushed on
// controller attach. NON-PII: command names + descriptions only.
function advertiseCommands(): { name: string; description?: string }[] {
  const builtins = [
    { name: "/model", description: "Switch the model" },
    { name: "/models", description: "List available models" },
    { name: "/mode", description: "Change the approval mode (default/acceptEdits/plan/bypass)" },
  ];
  let ext: { name: string; description?: string }[] = [];
  try {
    const cmds = piRef?.getCommands?.() ?? [];
    ext = cmds
      .map((c: any) => {
        const raw = c?.invocationName ?? c?.name ?? c?.command;
        if (!raw) return null;
        return { name: String(raw).startsWith("/") ? String(raw) : `/${raw}`, description: c?.description };
      })
      .filter(Boolean);
  } catch { /* no commands registered yet */ }
  // Terminal-only commands are withheld rather than advertised-then-refused, so the
  // app's composer never offers something it can't run. See runRemoteCommand.
  const seen = new Set([...builtins.map((c) => c.name), "/no-quarter"]);
  return [...builtins, ...ext.filter((c: any) => !seen.has(c.name))];
}

// Persistent footer indicator for remote access. When the relay is up, the footer
// shows a GREEN "⟿ remote access" line so it's always obvious this terminal can be
// driven from the phone — with a reminder that `/remote-access off` stops it. We
// keep a UI handle (captured from session_start / the command ctx) so the relay's
// own connect/disconnect callbacks can refresh the indicator, not just the command.
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
  // Paint from the active theme so the footer reads on a light terminal too (a bare
  // green/yellow escape can wash out on white) — falls back to white on no theme.
  const p = paletteFor(ui.theme);
  const text =
    remoteState === "connected"
      ? `${p.GREEN}⟿ remote access${p.RESET} ${p.DIM}· /remote-access off to stop${p.RESET}`
      : `${p.YELLOW}⟿ remote access · connecting…${p.RESET} ${p.DIM}· /remote-access off to stop${p.RESET}`;
  ui.setStatus(REMOTE_STATUS_KEY, text);
}

function setRemoteState(s: typeof remoteState): void {
  remoteState = s;
  refreshRemoteStatus();
}

// ── no quarter (shift+tab) ────────────────────────────────────────────────────
// The "step away from the keyboard" switch. On, the gate is fully lowered for the
// rest of the session: every action auto-approves with no prompt, so a long task
// runs to completion instead of stalling on the next approval. Off by default and
// reversible with the same key; the state itself lives in src/permissions/noQuarter.ts
// (shared with the launch flag and inherited by subagent children).
//
// The footer carries a permanent RED indicator while it's on — this is the one
// setting that turns the whole moat off, so it must never be quietly in effect.
const NO_QUARTER_STATUS_KEY = "privateer:no-quarter";

function refreshNoQuarterStatus(): void {
  const ui = uiRef;
  if (!ui?.setStatus) return;
  if (!noQuarterActive()) {
    ui.setStatus(NO_QUARTER_STATUS_KEY, undefined);
    return;
  }
  const p = paletteFor(ui.theme);
  ui.setStatus(
    NO_QUARTER_STATUS_KEY,
    `${p.RED}${p.BOLD}⚑ no quarter — permission gate OFF${p.RESET} ${p.DIM}· shift+tab to raise the moat${p.RESET}`,
  );
}

// Flip the state and tell the user, loudly on the way down. Takes effect from the
// next gated action — an approval already on screen still needs an answer.
function applyNoQuarter(on: boolean, ui: any): void {
  setNoQuarter(on);
  refreshNoQuarterStatus();
  ui?.notify?.(
    on
      ? "⚑ No quarter — the permission gate is OFF for this session. Every action (shell, edits, destructive tools, out-of-cwd, protected files) now runs without asking. shift+tab to raise the moat again."
      : "⚓ Moat raised — the permission gate is back on.",
    on ? "warning" : "info",
  );
}

// shift+tab, intercepted at the raw-input layer. Pi reserves that chord for
// `app.thinking.cycle`, so pi.registerShortcut("shift+tab") would be dropped as a
// conflict — a TUI input listener runs ahead of every component instead, and
// consuming the key stops it reaching the thinking-level cycler. (Thinking level
// stays reachable from /settings, or by binding app.thinking.cycle to another key.)
let unsubscribeKeys: (() => void) | undefined;

function bindNoQuarterKey(ui: any): void {
  if (typeof ui?.onTerminalInput !== "function") return; // older Pi / non-TUI mode
  unsubscribeKeys?.(); // a session replacement clears listeners — rebind, never double-bind
  unsubscribeKeys = ui.onTerminalInput((data: string) => {
    if (!matchesKey(data, "shift+tab")) return undefined;
    applyNoQuarter(!noQuarterActive(), ui);
    return { consume: true };
  });
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
    // Drop a prompt that arrives while a driven turn is already running (e.g. the app
    // re-sending after a reconnect) — sendUserMessage would otherwise throw "Agent is
    // already processing" and wedge the session. Tell the app why, don't crash.
    if (remoteTurnActive) {
      relay?.sendNotice("busy — a turn is already running; wait for it to finish.");
      return;
    }
    // Fold any files the app sent since the last prompt into a reference note so the
    // model knows they exist and can save_attachment them.
    const atts = sinceLastPrompt;
    sinceLastPrompt = [];
    const note = atts.length
      ? `\n\n[Files attached from the app: ${atts.map((a) => `#${a.n} ${a.name} (${a.mediaType})`).join(", ")}. ` +
        `Use the save_attachment tool with the ref number to write one to disk.]`
      : "";
    try {
      piRef?.sendUserMessage?.(text + note); // drive a turn in Pi's TUI
      remoteTurnActive = true; // cleared on agent_end
    } catch (e) {
      // A synchronous "already processing" (or any send failure) must not wedge the
      // bridge — surface it and stay idle so the next prompt still works.
      relay?.sendNotice(`couldn't start turn: ${(e as Error).message}`);
    }
  },
  onInterrupt: () => {}, // Pi owns interrupt; best-effort no-op
  // The app asked to end remote access from its side — stop the relay locally too so
  // the terminal doesn't keep reconnecting, and clear the green indicator.
  onTerminate: () => disableRemote(),
  // The account signed this terminal out server-side (revoked from the app's Linked
  // Devices). Unlike onTerminate, this wipes the machine login too: drop the relay,
  // then tear down the session. handleServerRevoke fires onSessionExpired, which the
  // brand extension handles (drops Pi's persisted account credential, refreshes the
  // banner, and notifies "your session was signed out — run /signin").
  onRevoked: () => {
    disableRemote();
    priv.handleServerRevoke();
  },
  // A slash command typed in the app composer (e.g. /model) — dispatch it through the
  // same picker flow the REPL uses. Feedback returns as notice/select_request/context.
  onCommand: (text) => void runRemoteCommand(text),
  onControllerAttached: () => {
    // A controller reached us → the socket is up and driving: go green. Resync the
    // snapshot, push live context (model + version) so the app banner reflects this
    // terminal, and advertise the slash commands for the composer's autocomplete.
    setRemoteState("connected");
    relay?.sendSnapshot([{ kind: "notice", text: "Privateer terminal connected." }]);
    relay?.sendContext({ model: currentSpec, version: agentVersion() });
    relay?.sendCommands(advertiseCommands());
  },
  onAttachment: (file) => sinceLastPrompt.push(attachments.register(file)),
  // Drive the indicator from the relay's own status stream: "connected" → green;
  // its reconnect/retry notices → yellow "connecting…". Ignored once we're off.
  onStatus: (text) => {
    if (!relay) return;
    if (/disconnect|reconnect|retry|couldn't|could not/i.test(text)) setRemoteState("connecting");
    else if (/connected/i.test(text)) setRemoteState("connected");
  },
  // The app's extensions manager: list the user's installed Pi extensions (the moat
  // is excluded), or add/remove one. See runExtMutation for the progress/restart flow.
  onExtensionsList: () => relay?.sendExtensions({ installed: extControl().listInstalled() }),
  onExtensionsAdd: (source) => void runExtMutation("add", source),
  onExtensionsRemove: (source) => void runExtMutation("remove", source),
  // The app's skills manager: list the terminal's skills, or create/delete/toggle a
  // user one. See runSkillMutation for the restart flow; Run-now is a /skill:name
  // command frame handled by Pi, not here.
  onSkillsList: () => relay?.sendSkills({ items: skillControl().listSkills() }),
  onSkillCreate: (skill) => void runSkillMutation(() => skillControl().createSkill(skill), "Saved"),
  onSkillDelete: (name) => void runSkillMutation(() => skillControl().deleteSkill(name), "Deleted"),
  onSkillSetEnabled: (name, enabled) => void runSkillMutation(() => skillControl().setEnabled(name, enabled), enabled ? "Enabled" : "Disabled"),
});

// Inside a subagent child (headless `pi`, stdin ignored), a gated action can't be
// approved locally — decideAuto still forces dangerous shell / destructive / secret-
// exfil to "ask", which would otherwise fail-closed to deny. If the root parent wired
// an approval channel (env-inherited), forward those asks to it so they reach the app;
// otherwise keep the fail-closed defaultLocalAsk (headless deny). A top-level TUI keeps
// its own interactive/remote gate.
const childChannel = isSubagentChild() ? inheritedChannelDir() : undefined;
const localAsk = childChannel ? makeChildGateAsk(childChannel) : defaultLocalAsk;

const gate = makePermissionGate({
  getMode: () => mode,
  setMode: (m) => (mode = m),
  allowlist,
  allowedOutsideRoots,
  cwd: process.cwd(),
  localAsk,
  getRemote: bridge.getRemote,
  getNoQuarter: bridge.getNoQuarter,
  // Session-wide TOTAL bypass: every action auto-approves, no prompt. Set either by
  // `--no-quarter` at launch (see bin/privateer-launch.mjs, which exports
  // PRIVATEER_NO_QUARTER) or by shift+tab mid-session — both land in the same state,
  // which subagent children inherit through the env. See src/permissions/noQuarter.ts.
  getSkipAllPermissions: noQuarterActive,
  remoteAsk: bridge.remoteAsk,
  // Billing tools this process was authorized for BEFORE it started. Only ever non-empty
  // inside a subagent child whose parent handed one down (childSpend.ts reads the env only
  // when pi-subagents has marked us a child), so a terminal keeps asking its human. This
  // is what lets an unattended run delegate a shot to a subagent: without it the child's
  // gate denies every generate_* call, having no one to ask.
  isSpendPreauthorized: (req) => childSpendAllows(req.tool),
});

export default function privateerControl(pi: any): void {
  piRef = pi;
  // The moat — tool_call (block/allow) + tool_result (redact).
  //
  // Unconditional, because this file now only loads where it is wanted: the interactive
  // TUI and subagent children get it as an explicit `-e` argument (bin/privateer-launch.mjs,
  // bin/privateer-subagent.mjs), and the processes that build their own gate from
  // makePermissionGate() never load it at all. It used to be conditional — this extension
  // was installed as a shim in the shared agent dir, so Pi discovered it into the harbor,
  // the channels runner and the REPL as well, and a second gate there meant either a
  // duplicate approval dialog or a fail-closed deny before the session's real approver was
  // consulted. The fix moved to the host: nothing of ours is discoverable any more, so the
  // gate no longer has to ask whose process it woke up in. See src/config/moat.ts.
  gate(pi);

  // Top-level session: watch the subagent approval channel and relay each child's
  // gated action to the app over this session's bridge. The bridge fails closed while
  // no controller is attached, so an undriven terminal denies a subagent's gated
  // action rather than auto-approving it. A subagent child never watches (it forwards).
  if (!isSubagentChild()) {
    startParentApprovalRelay(bridge, { onError: () => { /* best-effort; a poll error must not crash the turn */ } });
  }

  // File transfer both ways: send_file_to_client (CLI→app, via the bridge's relay) and
  // save_attachment (app→CLI, from the AttachmentStore inbound files land in). Both
  // live here because they share the RemoteBridge / its attachment stream.
  //
  // Also unconditional now, and for the same reason. These used to stand down inside the
  // harbor daemon: this extension was discovered into every session the daemon ran, where
  // `bridge` never gets a relay (only THIS file's /remote-access attaches one), so the pair
  // registered here would shadow — Pi resolves duplicate tool names first-registration-wins
  // — the session-scoped pair a live task spawn binds to its own connected relay, and
  // send_file_to_client would answer "remote access is off" while the app sat attached and
  // driving. The daemon no longer loads this file, so there is nothing to shadow.
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
    // Capture the model registry + launch model so the app's /model picker has this
    // machine's real catalog and the banner shows the current spec from the start.
    if (ctx?.modelRegistry) modelReg = ctx.modelRegistry;
    if (!currentSpec && ctx?.model) currentSpec = modelSpec(ctx.model);
    refreshRemoteStatus();
    // shift+tab → no quarter, and the red footer indicator when it's already on (a
    // `--no-quarter` launch, or a session replacement mid-run). Interactive TUI only:
    // headless modes and subagent children have no terminal to listen to.
    if (ctx?.mode === "tui" && ctx?.ui) {
      bindNoQuarterKey(ctx.ui);
      refreshNoQuarterStatus();
    }
    if (ctx?.mode && HEADLESS.has(ctx.mode) && (process.env.PRIVATEER_MODE ?? "") === "") {
      mode = "bypass";
    }
  });

  // Follow local model switches too (the user picking a model in the TUI): keep
  // currentSpec current and push context so a driving app's banner stays in sync.
  pi.on("model_select", (ev: any) => {
    if (ev?.model) {
      currentSpec = modelSpec(ev.model);
      relay?.sendContext({ model: currentSpec, version: agentVersion() });
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
    remoteTurnActive = false; // turn finished → the next app prompt may start one
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

  // The typed equivalent of shift+tab, for anyone who'd rather not trust a chord with
  // the whole moat. Deliberately NOT reachable from the app — see runRemoteCommand.
  pi.registerCommand?.("no-quarter", {
    description: "Lower the moat for this session — run unattended with no approval prompts: /no-quarter [on|off]",
    handler: (args: string, ctx: any) => {
      if (ctx?.ui) uiRef = ctx.ui;
      const arg = String(args ?? "").trim().toLowerCase();
      if (arg && arg !== "on" && arg !== "off") {
        return ctx.ui?.notify?.(`usage: /no-quarter [on|off] (currently ${noQuarterActive() ? "on" : "off"})`, "warning");
      }
      applyNoQuarter(arg ? arg === "on" : !noQuarterActive(), ctx.ui);
    },
  });

  // Local extension management. Mirrors what the app's extensions screen does over
  // the relay, but here we CAN hot-activate: ctx.reload() rebuilds the live runner,
  // so a just-added/removed extension takes effect without relaunching (a luxury the
  // relay path lacks — no command ctx there). Usage: /extensions [add|remove <src>].
  pi.registerCommand?.("extensions", {
    description: "Manage installed Pi extensions: /extensions [add <npm:pkg> | remove <npm:pkg>]",
    handler: async (args: string, ctx: any) => {
      const raw = String(args ?? "").trim();
      const [verb, ...rest] = raw.split(/\s+/);
      const source = rest.join(" ").trim();
      const ext = extControl();
      if (verb === "add" || verb === "remove") {
        if (!source) return ctx.ui?.notify?.(`Usage: /extensions ${verb} <npm:package>`, "warning");
        const res = verb === "add" ? await ext.add(source) : await ext.remove(source);
        if (!res.ok) return ctx.ui?.notify?.(res.message ?? `Couldn't ${verb} ${source}`, "warning");
        await ctx.reload?.(); // hot-activate: rebuild the live extension runner
        // Keep the app's screen in sync if it's attached.
        relay?.sendExtensions({ installed: ext.listInstalled() });
        return ctx.ui?.notify?.(`${verb === "add" ? "Added" : "Removed"} ${source}`, "info");
      }
      const installed = ext.listInstalled();
      ctx.ui?.notify?.(
        installed.length ? `Installed extensions:\n${installed.map((e) => `  ${e.source}`).join("\n")}` : "No extensions installed. Add them from the Privateer app or /extensions add <npm:pkg>.",
        "info",
      );
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
