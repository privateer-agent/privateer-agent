/**
 * Remote-access relay client (Phase 2).
 *
 * When the user enables /remote-access, the running TUI opens an outbound
 * WebSocket to the Privateer server's relay. The app ("controller") can then
 * drive THIS terminal ("agent"): it sends prompts down, and we stream the
 * engine's events + tool-approval requests back up. Tool execution still runs
 * locally and stays gated — a remote-driven turn relays every would-be action
 * to the app for Allow/Deny (see uiGate.ts getRemote).
 *
 * The socket is authenticated with a single-use, short-TTL ticket minted over
 * the authenticated REST channel (RN can't set WS headers and a JWT in the URL
 * would leak). We never carry the JWT into the WS URL.
 *
 * Framework-agnostic: nothing here imports React. The App owns an instance via
 * a ref and wires the callbacks to its turn loop.
 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { apiRequest, serverBaseUrl } from "../auth/privateer.ts";
import type { EngineEvent } from "../engine/events.ts";
import type { PermissionRequest } from "../permissions/gate.ts";

// Display label for THIS running terminal. Deliberately NON-PII: we do NOT send
// username@hostname or the working-directory name to the server/controller (the
// server is supposed to learn as little as possible). A short random tag lets the
// user tell multiple terminals apart; they can rename it in the app.
function terminalLabel(): string {
  return `terminal-${randomUUID().slice(0, 4)}`;
}

// Best-effort redaction of secret-looking content before it crosses the relay to
// the controller/server. This is a SAFETY NET, not a guarantee — truncation
// bounds size, this bounds obvious secret leakage (bearer tokens, API keys, env
// secrets, PEM private keys). The "output may contain secrets" warning still
// stands; a determined leak (unusual formats) can slip through.
// Pull the account signature / freshness ts off a control frame, if well-formed.
// Undefined when absent or the wrong type → the terminal's authorizeControl fails
// closed (an unsigned mutation is refused).
function sig(frame: { sig?: unknown }): string | undefined {
  return typeof frame.sig === "string" ? frame.sig : undefined;
}
function tsOf(frame: { ts?: unknown }): number | undefined {
  return typeof frame.ts === "number" ? frame.ts : undefined;
}

// Parse a task_submit/task_spawn frame into a TaskSpec, keeping ONLY well-typed,
// present fields (absent → left undefined). The daemon re-derives the canonical signed
// args from this (taskControlArgs, undefined → null), so it must not invent fields.
export function parseTaskSpec(frame: {
  prompt?: string;
  cwd?: string;
  model?: string;
  title?: string;
  tools?: unknown;
}): TaskSpec {
  const spec: TaskSpec = { prompt: typeof frame.prompt === "string" ? frame.prompt : "" };
  if (typeof frame.cwd === "string") spec.cwd = frame.cwd;
  if (typeof frame.model === "string") spec.model = frame.model;
  if (typeof frame.title === "string") spec.title = frame.title;
  if (Array.isArray(frame.tools) && frame.tools.every((t) => typeof t === "string")) {
    spec.tools = frame.tools as string[];
  }
  return spec;
}

function redactSecrets(s: string): string {
  if (!s) return s;
  return s
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(bearer)\s+[A-Za-z0-9._\-]{12,}/gi, "$1 [redacted]")
    .replace(/\b(sk|rk|pk|ghp|gho|ghs|github_pat|AKIA|ASIA)[-_][A-Za-z0-9]{8,}/g, "[redacted key]")
    .replace(/\b([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE)[A-Z0-9_]*)\s*[:=]\s*['"]?[^\s'"]{6,}/gi, "$1=[redacted]");
}

// Redact then clip: redaction runs on full text so a secret near the cut isn't
// missed, then we bound the wire size.
function safe(s: string, max: number): string {
  return clip(redactSecrets(s), max);
}

// An ad-hoc task the app asks the daemon to run headlessly (task_submit) or to spawn
// as a live-drivable session (task_spawn). Only `prompt` is required; the rest fall back
// to daemon defaults. The SAME field set is what the app canonical-signs into the control
// envelope (client/services/accountSign.ts) and the daemon re-derives to verify (index.ts
// taskControlArgs) — keep the two in sync, byte for byte, like the other signed frames.
export interface TaskSpec {
  prompt: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  title?: string;
}

export interface RelayCallbacks {
  // A prompt arrived from the app — feed it into the turn loop (tagged remote).
  onPrompt: (text: string) => void;
  // The app asked to interrupt the in-flight turn.
  onInterrupt: () => void;
  // The app asked to turn remote access OFF entirely (the in-app "End remote
  // access" action). The owner should disable /remote-access — i.e. stop this
  // client and not reconnect. Optional: the routines daemon handles it too, but
  // callbacks that predate it keep compiling.
  onTerminate?: () => void;
  // The account signed this terminal out server-side (revoked from the app's
  // Linked Devices). Distinct from onTerminate: that only ends remote-access and
  // leaves the login intact, whereas this wipes the machine login too. The owner
  // should tear down the session (clear credentials, announce it) AND stop the
  // relay. Optional so callbacks that predate the frame keep compiling; an older
  // CLI that ignores it still gets signed out by the ≤25s heartbeat kill.
  onRevoked?: () => void;
  // The app answered a relayed approval request.
  onApprovalResponse: (id: string, decision: "allow" | "deny") => void;
  // The app toggled no-quarter (unattended) mode: remote turns auto-approve like
  // bypass mode instead of relaying every action, so the agent runs to completion.
  // Dangerous/destructive actions still relay — they sit above bypass locally too.
  onNoQuarter?: (on: boolean) => void;
  // A controller attached — push a transcript snapshot so it can catch up.
  onControllerAttached: () => void;
  // The app ran a slash command from its composer (e.g. "/model provider/id").
  // Routed to the same command dispatcher the local REPL uses. Optional so
  // callbacks that predate the app command UI keep compiling.
  onCommand?: (text: string) => void;
  // The app answered a CLI-initiated selection prompt (the id from requestSelect).
  // A null value means the app dismissed the picker without choosing.
  onSelectResponse?: (id: string, value: string | null) => void;
  // The app answered a CLI-initiated text-input prompt (the id from requestInput).
  // A null value means the app dismissed the prompt without submitting.
  onInputResponse?: (id: string, value: string | null) => void;
  // The app's composer is autocompleting an `@file` mention — reply with the cwd
  // files/dirs matching `query` (a sendFileMatches frame, keyed by the same id).
  // Read-only; resolution of the picked path still happens on the prompt turn.
  onFilesSearch?: (id: string, query: string) => void;
  // The app opened the extensions manager — reply with the current installed list
  // (a sendExtensions frame). Optional so pre-extensions callbacks keep compiling.
  onExtensionsList?: () => void;
  // The app asked to install a Pi extension by source spec (npm:/git:/path).
  // `sig`+`ts` authenticate the mutation with the account key (H2, verified via
  // controlAuth) — a forged extensions_add would install attacker code, so it's signed.
  onExtensionsAdd?: (source: string, sig?: string, ts?: number) => void;
  // The app asked to remove a previously-installed extension by source spec.
  onExtensionsRemove?: (source: string, sig?: string, ts?: number) => void;
  // The app opened the skills manager — reply with the current skills list
  // (a sendSkills frame). Optional so pre-skills callbacks keep compiling.
  onSkillsList?: () => void;
  // The app asked to create/overwrite a user skill (name + description + body). Signed
  // (H2) — a forged skill would inject an auto-invoked system-prompt instruction.
  onSkillCreate?: (skill: { name: string; description: string; instructions: string }, sig?: string, ts?: number) => void;
  // The app asked to delete a user skill by name.
  onSkillDelete?: (name: string, sig?: string, ts?: number) => void;
  // The app toggled a user skill's model-invocation availability.
  onSkillSetEnabled?: (name: string, enabled: boolean, sig?: string, ts?: number) => void;
  // The app opened the routines manager — reply with the current routines list
  // (a sendRoutines frame). Owned by the daemon, so these only fire on its relay.
  onRoutinesList?: () => void;
  // The app asked to create (no id) or edit (id) a routine. The raw draft object is
  // handed through untyped; the daemon's routinesControl validates it. Signed (H2) —
  // a forged routine runs a headless bypass-mode session (RCE), so it MUST be verified.
  onRoutinesSave?: (draft: Record<string, unknown>, sig?: string, ts?: number) => void;
  // The app asked to delete a routine by id or name.
  onRoutinesDelete?: (idOrName: string, sig?: string, ts?: number) => void;
  // The app paused/resumed a routine by id or name.
  onRoutinesSetEnabled?: (idOrName: string, enabled: boolean, sig?: string, ts?: number) => void;
  // The app asked to run a routine now, by id or name.
  onRoutinesRun?: (idOrName: string, sig?: string, ts?: number) => void;
  // The app submitted an AD-HOC one-shot task (not a stored routine) to run headlessly
  // right now — a fresh restricted-tool bypass session whose result is sealed to the
  // account outbox. Signed (H2) — a forged task_submit runs an arbitrary headless
  // session (RCE), identical in blast radius to a forged routines_run, so it MUST be
  // verified via controlAuth before it runs. Daemon-owned (fires only on its relay).
  onTaskSubmit?: (spec: TaskSpec, sig?: string, ts?: number) => void;
  // The app asked to SPAWN a fresh interactive session it can drive live (mode:"live").
  // The daemon stands up a new RemoteBridge terminal and replies (sendTaskSpawned) with
  // its termId so the app can attach. Same signed-RCE gate as task_submit.
  onTaskSpawn?: (spec: TaskSpec, sig?: string, ts?: number) => void;
  // The app opened the channels manager — reply with the current channel config
  // (a sendChannels frame). Owned by the daemon, so these only fire on its relay.
  onChannelsList?: () => void;
  // The app asked to create/edit a platform's channel config. `draft` carries only
  // NON-secret fields (roles/posture/tools/model). `sealedSecrets`, when present, is
  // a base64 sealed-box the app sealed to THIS terminal's pinned pubkey (opened by the
  // owner). `sig`+`ts` authenticate the WHOLE save with the account key the terminal
  // pinned at link (accountVerify) — the owner rejects an unsigned/forged/stale save,
  // so a hostile relay can neither forge a token nor inject an admin.
  onChannelsSave?: (draft: Record<string, unknown>, sealedSecrets?: string, sig?: string, ts?: number) => void;
  // The app asked to delete a platform's channel config, by platform name. Signed
  // (H2) — a forged removal is a DoS (the bot stops until re-added).
  onChannelsRemove?: (platform: string, sig?: string, ts?: number) => void;
  // The app opened the MCP connectors manager — reply with the current MCP config
  // (a sendMcp frame). Owned by the daemon (the host that runs the adapter), so these
  // only fire on its relay. Read-only, so unsigned.
  onMcpList?: () => void;
  // The app asked to create/edit an MCP connector. `draft` carries only NON-secret
  // fields (name/transport/command/args/url/oauth). `sealedSecrets`, when present, is
  // a base64 sealed-box the app sealed to THIS terminal's pinned pubkey, opening to
  // `{ termId, env: {NAME: value} }` — the connector's credential env. `sig`+`ts`
  // authenticate the WHOLE save with the pinned account key (same shape as
  // channels_save), so a hostile relay can neither forge a token nor inject a command.
  onMcpSave?: (draft: Record<string, unknown>, sealedSecrets?: string, sig?: string, ts?: number) => void;
  // The app asked to enable/disable a connector by name. Signed (H2) — a forged toggle
  // silently arms/disarms a tool surface. Idempotent (non-strict ts).
  onMcpSetEnabled?: (name: string, enabled: boolean, sig?: string, ts?: number) => void;
  // The app asked to delete a connector by name. Signed (H2) — a forged removal is a DoS.
  onMcpRemove?: (name: string, sig?: string, ts?: number) => void;
  // The app opened the workflows manager — reply with the current workflow summaries
  // (a sendWorkflows frame). Owned by the daemon, so these only fire on its relay.
  onWorkflowsList?: () => void;
  // The app opened one workflow in its editor — reply with the full graph (sendWorkflow).
  onWorkflowsGet?: (idOrName: string) => void;
  // The app asked to create (no workflow.id) or edit (id) a workflow. The raw graph is
  // handed through untyped; the daemon's workflowsControl strict-validates it. Signed
  // (H2) — a forged save plants a `script` step that BYPASSES the permission gate (RCE),
  // exactly like a forged routine, so it MUST be verified before it persists.
  onWorkflowsSave?: (draft: Record<string, unknown>, sig?: string, ts?: number) => void;
  // The app asked to delete a workflow by id or name. Signed (H2).
  onWorkflowsRemove?: (idOrName: string, sig?: string, ts?: number) => void;
  // The app asked to run a workflow now, by id or name. Signed (H2) and verified in
  // STRICT mode (it executes a graph — non-idempotent, like task_spawn).
  onWorkflowsRun?: (idOrName: string, sig?: string, ts?: number) => void;
  // A file finished transferring from the app (reassembled from chunks). Held to
  // ride along with the next remote prompt.
  onAttachment: (file: { name: string; mediaType: string; base64: string }) => void;
  // Surface a one-line status/notice in the TUI.
  onStatus?: (text: string) => void;
  // The relay socket closed (controller no longer reachable until reconnect).
  onDisconnected?: () => void;
}

const RECONNECT_MS = 3000;
// File-transfer ceilings for app→CLI attachments. The app enforces its own caps
// before sending; these are a defensive backstop so a controller can't exhaust
// memory with a lying `size` or a flood of concurrent transfers.
const MAX_ATTACH_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_INFLIGHT_ATTACH = 8; // simultaneous transfers
// Base64 chars per file_chunk frame for agent→app sends (~135 KB decoded), kept
// under the relay's 256 KB per-frame cap. Mirrors the app's CHUNK_CHARS.
const FILE_CHUNK_CHARS = 180_000;
// Coalesce streaming deltas so we don't emit one WS frame per token.
const TEXT_FLUSH_MS = 60;

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… (${s.length - max} more chars)`;
}

function asText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

// A relay-specific projection of an EngineEvent: serializable + size-bounded.
// The raw event's tool input/output are `unknown` and bash output can be ~30k
// chars, so we normalize to text and truncate before sending over the wire.
function projectEvent(ev: EngineEvent): Record<string, unknown> {
  switch (ev.type) {
    case "tool-call":
      return { type: "tool-call", id: ev.id, name: ev.name, input: safe(asText(ev.input), 2000) };
    case "tool-result":
      return { type: "tool-result", id: ev.id, name: ev.name, output: safe(asText(ev.output), 4000) };
    case "tool-error":
      return { type: "tool-error", id: ev.id, name: ev.name, error: safe(ev.error, 2000) };
    case "usage":
      return { type: "usage", usage: ev.usage, turn: ev.turn };
    case "finish":
      return { type: "finish", finishReason: ev.finishReason };
    case "routed":
      return { type: "routed", label: ev.label, reason: ev.reason };
    case "retrying":
      return { type: "retrying", attempt: ev.attempt, max: ev.max, reason: clip(ev.reason, 500) };
    case "error":
      return { type: "error", error: clip(ev.error, 2000), hint: ev.hint };
    case "compacted":
      return { type: "compacted", before: ev.before, after: ev.after };
    case "aborted":
      return { type: "aborted" };
    case "step-finish":
      return { type: "step-finish" };
    default:
      // text/reasoning are coalesced in sendEvent and never reach here.
      return { type: ev.type };
  }
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private closed = false;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // Ordered delta buffer (text/reasoning) coalesced into one frame per flush.
  private bufKind: "text" | "reasoning" | null = null;
  private buf = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  // Stable for this process so reconnects keep the same terminal identity. Callers
  // may pass a persisted id/label (e.g. the routines daemon, so it shows up as one
  // recognizable "Privateer Routines" terminal across restarts instead of a fresh
  // random one each time).
  private readonly termId: string;
  private readonly label: string;
  // In-progress file transfers from the app, keyed by the controller's attachment
  // id. Reassembled from attach_begin/chunk/end frames, then handed to onAttachment.
  private readonly incoming = new Map<
    string,
    { name: string; mediaType: string; chunks: string[]; received: number }
  >();

  constructor(
    private readonly cb: RelayCallbacks,
    opts?: { termId?: string; label?: string },
  ) {
    this.termId = opts?.termId ?? randomUUID();
    this.label = opts?.label ?? terminalLabel();
  }

  // This terminal's relay id — the value the app signs into a control envelope's
  // `termId` and the terminal verifies against (authorizeControl). Exposed so the
  // interactive handlers (extensions_*/skills_*) can bind their own id.
  get id(): string {
    return this.termId;
  }

  async start(): Promise<void> {
    this.closed = false;
    await this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    this.bufKind = null;
    this.buf = "";
    this.incoming.clear();
    try { this.ws?.close(); } catch (_) { /* ignore */ }
    this.ws = null;
  }

  private async connect(): Promise<void> {
    if (this.closed || this.connecting || this.ws) return;
    this.connecting = true;
    try {
      // apiRequest → authedFetch refreshes the JWT on 401, so a single in-flight
      // ticket mint never races a second refresher (we guard with `connecting`).
      const res = await apiRequest("/relay/ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "agent", termId: this.termId, label: this.label }),
      });
      if (!res.ok) throw new Error(`relay ticket HTTP ${res.status}`);
      const { ticket } = (await res.json()) as { ticket: string };

      const wsUrl =
        serverBaseUrl().replace(/^http/, "ws") + `/relay?ticket=${encodeURIComponent(ticket)}`;
      this.debug(`connecting → ${wsUrl}`);
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      let opened = false;
      let lastErr = "";

      ws.on("open", () => {
        opened = true;
        this.cb.onStatus?.("Remote access connected — drive this terminal from the Privateer app.");
      });
      ws.on("message", (data) => this.handle(data));
      ws.on("close", () => {
        if (this.ws === ws) this.ws = null;
        this.cb.onDisconnected?.();
        if (!this.closed) {
          this.cb.onStatus?.(
            opened
              ? "Remote access disconnected — reconnecting…"
              : `Remote access couldn't connect${lastErr ? ` (${lastErr})` : ""} — retrying…`,
          );
        }
        this.scheduleReconnect();
      });
      ws.on("error", (err: Error) => {
        // 'close' fires right after and surfaces the reason; just capture it.
        lastErr = err?.message || String(err);
        this.debug(`ws error: ${lastErr}`);
      });
    } catch (err) {
      // Ticket mint failed (auth/network/route) — surface it; a silent failure
      // looks identical to "connected but ignoring me".
      const msg = err instanceof Error ? err.message : String(err);
      this.cb.onStatus?.(`Remote access couldn't reach the relay (${msg}) — retrying…`);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private debug(msg: string): void {
    if (process.env.PRIVATEER_RELAY_DEBUG) this.cb.onStatus?.(`relay: ${msg}`);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, RECONNECT_MS);
  }

  private handle(data: WebSocket.RawData): void {
    let frame: {
      type?: string;
      text?: string;
      id?: string;
      decision?: string;
      name?: string;
      mediaType?: string;
      size?: number;
      seq?: number;
      data?: string;
      on?: boolean;
      value?: string;
      source?: string;
      description?: string;
      instructions?: string;
      enabled?: boolean;
      idOrName?: string;
      routine?: Record<string, unknown>;
      platform?: string;
      draft?: Record<string, unknown>;
      sealedSecrets?: string;
      prompt?: string;
      cwd?: string;
      model?: string;
      title?: string;
      tools?: unknown;
      mode?: string;
      query?: string;
      sig?: string;
      ts?: number;
    };
    try {
      frame = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    this.debug(`recv ${frame.type}`);
    switch (frame.type) {
      case "prompt":
        // Forward even an empty/whitespace prompt: a file-only send carries no text,
        // and the app folds any pending attachments in on the prompt frame. App.tsx
        // no-ops a blank prompt that has no attachments, so this stays safe.
        if (typeof frame.text === "string") this.cb.onPrompt(frame.text);
        break;
      case "interrupt":
        this.cb.onInterrupt();
        break;
      case "terminate":
        this.cb.onTerminate?.();
        break;
      case "session_revoked":
        this.cb.onRevoked?.();
        break;
      case "approval_response":
        if (frame.id) this.cb.onApprovalResponse(frame.id, frame.decision === "deny" ? "deny" : "allow");
        break;
      case "no_quarter":
        this.cb.onNoQuarter?.(frame.on === true);
        break;
      case "controller_attached":
        this.cb.onControllerAttached();
        break;
      case "command":
        if (typeof frame.text === "string") this.cb.onCommand?.(frame.text);
        break;
      case "select_response":
        if (frame.id) this.cb.onSelectResponse?.(frame.id, typeof frame.value === "string" ? frame.value : null);
        break;
      case "input_response":
        if (frame.id) this.cb.onInputResponse?.(frame.id, typeof frame.value === "string" ? frame.value : null);
        break;
      case "files_search":
        if (typeof frame.id === "string") this.cb.onFilesSearch?.(frame.id, typeof frame.query === "string" ? frame.query : "");
        break;
      case "extensions_list":
        this.cb.onExtensionsList?.();
        break;
      case "extensions_add":
        if (typeof frame.source === "string") this.cb.onExtensionsAdd?.(frame.source, sig(frame), tsOf(frame));
        break;
      case "extensions_remove":
        if (typeof frame.source === "string") this.cb.onExtensionsRemove?.(frame.source, sig(frame), tsOf(frame));
        break;
      case "skills_list":
        this.cb.onSkillsList?.();
        break;
      case "skills_create":
        if (typeof frame.name === "string") {
          this.cb.onSkillCreate?.(
            {
              name: frame.name,
              description: typeof frame.description === "string" ? frame.description : "",
              instructions: typeof frame.instructions === "string" ? frame.instructions : "",
            },
            sig(frame),
            tsOf(frame),
          );
        }
        break;
      case "skills_delete":
        if (typeof frame.name === "string") this.cb.onSkillDelete?.(frame.name, sig(frame), tsOf(frame));
        break;
      case "skills_set_enabled":
        if (typeof frame.name === "string") this.cb.onSkillSetEnabled?.(frame.name, frame.enabled === true, sig(frame), tsOf(frame));
        break;
      case "routines_list":
        this.cb.onRoutinesList?.();
        break;
      case "routines_save":
        if (frame.routine && typeof frame.routine === "object") this.cb.onRoutinesSave?.(frame.routine, sig(frame), tsOf(frame));
        break;
      case "routines_delete":
        if (typeof frame.idOrName === "string") this.cb.onRoutinesDelete?.(frame.idOrName, sig(frame), tsOf(frame));
        break;
      case "routines_set_enabled":
        if (typeof frame.idOrName === "string") this.cb.onRoutinesSetEnabled?.(frame.idOrName, frame.enabled === true, sig(frame), tsOf(frame));
        break;
      case "routines_run":
        if (typeof frame.idOrName === "string") this.cb.onRoutinesRun?.(frame.idOrName, sig(frame), tsOf(frame));
        break;
      case "task_submit":
        if (typeof frame.prompt === "string") this.cb.onTaskSubmit?.(parseTaskSpec(frame), sig(frame), tsOf(frame));
        break;
      case "task_spawn":
        if (typeof frame.prompt === "string") this.cb.onTaskSpawn?.(parseTaskSpec(frame), sig(frame), tsOf(frame));
        break;
      case "channels_list":
        this.cb.onChannelsList?.();
        break;
      case "channels_save":
        if (frame.draft && typeof frame.draft === "object") {
          this.cb.onChannelsSave?.(
            frame.draft,
            typeof frame.sealedSecrets === "string" ? frame.sealedSecrets : undefined,
            sig(frame),
            tsOf(frame),
          );
        }
        break;
      case "channels_remove":
        if (typeof frame.platform === "string") this.cb.onChannelsRemove?.(frame.platform, sig(frame), tsOf(frame));
        break;
      case "mcp_list":
        this.cb.onMcpList?.();
        break;
      case "mcp_save":
        // The connector rides in `draft` (same slot as channels_save), untyped — the
        // daemon strict-validates it via mcpControl.save after the signature check.
        if (frame.draft && typeof frame.draft === "object") {
          this.cb.onMcpSave?.(
            frame.draft,
            typeof frame.sealedSecrets === "string" ? frame.sealedSecrets : undefined,
            sig(frame),
            tsOf(frame),
          );
        }
        break;
      case "mcp_set_enabled":
        if (typeof frame.name === "string") this.cb.onMcpSetEnabled?.(frame.name, frame.enabled === true, sig(frame), tsOf(frame));
        break;
      case "mcp_remove":
        if (typeof frame.name === "string") this.cb.onMcpRemove?.(frame.name, sig(frame), tsOf(frame));
        break;
      case "workflows_list":
        this.cb.onWorkflowsList?.();
        break;
      case "workflows_get":
        if (typeof frame.idOrName === "string") this.cb.onWorkflowsGet?.(frame.idOrName);
        break;
      case "workflows_save":
        // The graph rides in `draft` (same slot as channels_save), untyped — the daemon
        // strict-validates it via workflowsControl.save after the signature check.
        if (frame.draft && typeof frame.draft === "object") this.cb.onWorkflowsSave?.(frame.draft, sig(frame), tsOf(frame));
        break;
      case "workflows_remove":
        if (typeof frame.idOrName === "string") this.cb.onWorkflowsRemove?.(frame.idOrName, sig(frame), tsOf(frame));
        break;
      case "workflows_run":
        if (typeof frame.idOrName === "string") this.cb.onWorkflowsRun?.(frame.idOrName, sig(frame), tsOf(frame));
        break;
      case "attach_begin":
        this.beginAttachment(frame);
        break;
      case "attach_chunk":
        this.appendAttachmentChunk(frame);
        break;
      case "attach_end":
        this.endAttachment(frame);
        break;
    }
  }

  // ── app → agent file transfer (chunked) ─────────────────────────────────────
  // Files are streamed as attach_begin → attach_chunk* → attach_end so each WS
  // frame stays under the relay's 256 KB cap. We reassemble here and hand the
  // completed file up via onAttachment; App.tsx folds it into the next prompt.

  private beginAttachment(frame: { id?: string; name?: string; mediaType?: string; size?: number }): void {
    const { id } = frame;
    if (!id || typeof frame.name !== "string" || typeof frame.mediaType !== "string") return;
    if (this.incoming.size >= MAX_INFLIGHT_ATTACH) {
      this.cb.onStatus?.(`Dropped attachment "${frame.name}" — too many transfers in flight.`);
      return;
    }
    if (typeof frame.size === "number" && frame.size > MAX_ATTACH_BYTES) {
      this.cb.onStatus?.(`Dropped attachment "${frame.name}" — exceeds ${Math.round(MAX_ATTACH_BYTES / (1024 * 1024))} MB.`);
      return;
    }
    this.incoming.set(id, { name: frame.name, mediaType: frame.mediaType, chunks: [], received: 0 });
  }

  private appendAttachmentChunk(frame: { id?: string; data?: string }): void {
    const { id } = frame;
    if (!id || typeof frame.data !== "string") return;
    const entry = this.incoming.get(id);
    if (!entry) return; // begin was dropped or never seen
    entry.received += frame.data.length;
    // base64 inflates by ~4/3, so received*0.75 ≈ decoded bytes. Bound it in case
    // `size` was absent or lied at begin time.
    if (entry.received * 0.75 > MAX_ATTACH_BYTES + 64 * 1024) {
      this.incoming.delete(id);
      this.cb.onStatus?.(`Dropped attachment "${entry.name}" — stream exceeded size limit.`);
      return;
    }
    entry.chunks.push(frame.data);
  }

  private endAttachment(frame: { id?: string }): void {
    const { id } = frame;
    if (!id) return;
    const entry = this.incoming.get(id);
    if (!entry) return;
    this.incoming.delete(id);
    const base64 = entry.chunks.join("");
    if (!base64) return;
    this.cb.onAttachment({ name: entry.name, mediaType: entry.mediaType, base64 });
  }

  private rawSend(frame: unknown): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(frame)); } catch (_) { /* socket dying */ }
    }
  }

  // ── agent → controller ──────────────────────────────────────────────────────

  // Is the relay socket currently open? (Not the same as "a controller is
  // attached" — the server forwards to a controller only when one is present.)
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // Push a finished routine result to any attached controller as a text event, so
  // it renders in the app's live feed. Returns whether the socket was open to send
  // on; a durable channel (file/notice) still backs this up, since we can't know
  // for certain a controller was attached.
  sendRoutineResult(name: string, content: string): boolean {
    if (!this.isConnected()) return false;
    this.flushDeltas();
    this.rawSend({ type: "event", event: { type: "text", text: safe(`⏺ Routine "${name}"\n\n${content}`, 8000) } });
    return true;
  }

  // Push a finished ad-hoc task result to any attached controller as a text event (the
  // durable copy still goes to the outbox). Same shape as sendRoutineResult.
  sendTaskResult(title: string, content: string): boolean {
    if (!this.isConnected()) return false;
    this.flushDeltas();
    this.rawSend({ type: "event", event: { type: "text", text: safe(`⏺ Task "${title}"\n\n${content}`, 8000) } });
    return true;
  }

  // Push a workflow's live step text / final result to any attached controller as a text
  // event, so it renders in the daemon terminal's feed. Same durable-copy caveat as
  // sendRoutineResult (the outbox is the source of truth).
  sendWorkflowResult(name: string, content: string): boolean {
    if (!this.isConnected()) return false;
    this.flushDeltas();
    this.rawSend({ type: "event", event: { type: "text", text: safe(`⏺ Workflow "${name}"\n\n${content}`, 8000) } });
    return true;
  }

  // Tell the app that a live task session was stood up on `termId` (label for display),
  // so it can open a controller connection to that terminal and drive it. Fire-and-forget
  // over the daemon's management relay.
  sendTaskSpawned(termId: string, label: string): void {
    this.rawSend({ type: "task_spawned", termId, label });
  }

  sendEvent(ev: EngineEvent): void {
    if (ev.type === "text") return this.bufferDelta("text", ev.text);
    if (ev.type === "reasoning") return this.bufferDelta("reasoning", ev.text);
    this.flushDeltas(); // preserve ordering relative to buffered text
    this.rawSend({ type: "event", event: projectEvent(ev) });
  }

  // Catch-up history sent to a controller on attach. Structured (not markdown) so
  // the app renders it with the same styling as the live feed. Bounded: last 80
  // entries, each clipped.
  sendSnapshot(entries: { kind: string; text: string }[]): void {
    const trimmed = entries.slice(-80).map((e) => ({ kind: e.kind, text: safe(String(e.text ?? ""), 4000) }));
    this.rawSend({ type: "snapshot", entries: trimmed });
  }

  // ── agent → app file transfer (chunked) ─────────────────────────────────────
  // Reverse of the attach_* path: file_begin → file_chunk* → file_end, each frame
  // under the relay's 256 KB cap. Fire-and-forget past the socket — the server
  // drops frames when no controller is attached and there is no ack, so "ok" means
  // "handed to an open socket", not "the app received it". The payload is base64
  // binary, so no redactSecrets (it would corrupt the bytes) — the caller decides
  // what's safe to send.
  async sendFile(file: {
    name: string;
    mediaType: string;
    base64: string;
    size: number;
  }): Promise<{ ok: boolean; reason?: string }> {
    if (!this.isConnected()) return { ok: false, reason: "relay socket not connected" };
    if (file.size > MAX_ATTACH_BYTES) {
      return { ok: false, reason: `exceeds the ${Math.round(MAX_ATTACH_BYTES / (1024 * 1024))} MB relay limit` };
    }
    this.flushDeltas(); // land the file in order relative to buffered text
    const id = randomUUID();
    this.rawSend({ type: "file_begin", id, name: file.name, mediaType: file.mediaType, size: file.size });
    for (let off = 0, seq = 0; off < file.base64.length; off += FILE_CHUNK_CHARS, seq++) {
      if (!this.isConnected()) return { ok: false, reason: "connection lost mid-transfer" };
      this.rawSend({ type: "file_chunk", id, seq, data: file.base64.slice(off, off + FILE_CHUNK_CHARS) });
      // Yield between frames of a multi-chunk file so a big send doesn't starve
      // the event loop (ws buffers internally; no drain dance needed at ≤10 MB).
      if (file.base64.length > FILE_CHUNK_CHARS) await new Promise((r) => setImmediate(r));
    }
    if (!this.isConnected()) return { ok: false, reason: "connection lost mid-transfer" };
    this.rawSend({ type: "file_end", id });
    return { ok: true };
  }

  // Echo the no-quarter (unattended auto-approve) state up to the controller so
  // its toggle reflects what this terminal is actually doing. Sent on every
  // change (ack) and on controller attach (a re-attaching app resyncs).
  sendNoQuarter(on: boolean): void {
    this.rawSend({ type: "no_quarter", on });
  }

  // Push this terminal's live context (selected model, agent version) to a
  // controller so the app's session banner reflects reality instead of a stub.
  // Sent on controller attach — like the snapshot/no_quarter resync. NON-PII ONLY
  // by design: deliberately NO cwd / hostname / username, matching terminalLabel's
  // stance (the server/controller learns as little as possible about the machine).
  // Empty/absent fields are omitted so the app renders less rather than blank.
  sendContext(ctx: { model?: string; version?: string; terminalPub?: string }): void {
    const frame: Record<string, unknown> = { type: "context" };
    if (typeof ctx.model === "string" && ctx.model) frame.model = ctx.model;
    if (typeof ctx.version === "string" && ctx.version) frame.version = ctx.version;
    // The terminal's identity public key (base64). NOT PII — it's a public key, and
    // the app uses it to confirm this terminal is the one it PINNED at link time
    // before sealing any secret to it (channel tokens). A malicious relay can swap
    // it, which is exactly why the app checks it against the link-time pin.
    if (typeof ctx.terminalPub === "string" && ctx.terminalPub) frame.terminalPub = ctx.terminalPub;
    this.rawSend(frame);
  }

  // A one-line notice for the app's feed (e.g. "model → …", "unknown command").
  // The generic command-feedback channel back to the driver.
  sendNotice(text: string): void {
    this.rawSend({ type: "notice", text: safe(text, 500) });
  }

  // Advertise the terminal's available slash commands (this CLI's built-ins PLUS
  // whatever Pi extensions have registered) so the app's composer can autocomplete
  // them. Pushed on controller attach. NON-PII: command names + descriptions only.
  sendCommands(commands: { name: string; description?: string }[]): void {
    this.rawSend({
      type: "commands",
      commands: commands.slice(0, 200).map((c) => ({ name: c.name, description: c.description ? safe(c.description, 200) : undefined })),
    });
  }

  // Reply to an `@file` autocomplete query with the matching cwd files/dirs. Keyed by
  // the query's id so the app can match it to the in-flight request. Bounded; paths are
  // cwd-relative (the caller — searchFiles — never emits a path outside the cwd subtree,
  // so no machine location leaks beyond the project filenames the driver is browsing).
  sendFileMatches(id: string, matches: { path: string; isDir: boolean }[]): void {
    this.rawSend({
      type: "file_matches",
      id,
      matches: matches.slice(0, 50).map((m) => ({ path: safe(m.path, 300), isDir: !!m.isDir })),
    });
  }

  // Push the terminal's installed Pi extensions (the user's own packages; the moat
  // is excluded upstream) to the app's extensions manager. Sent on request and after
  // each add/remove. `busy` drives a progress indicator; `needsRestart` tells the app
  // the change only takes effect on the next terminal launch. NON-PII: package
  // sources + scope only. Installed list bounded like sendCommands.
  sendExtensions(payload: {
    installed: { source: string; scope: string; filtered?: boolean; installed?: boolean }[];
    busy?: boolean;
    message?: string;
    needsRestart?: boolean;
  }): void {
    this.rawSend({
      type: "extensions",
      installed: payload.installed.slice(0, 200).map((e) => ({
        source: safe(e.source, 200),
        scope: e.scope === "project" ? "project" : "user",
        filtered: !!e.filtered,
        installed: !!e.installed,
      })),
      busy: !!payload.busy,
      message: payload.message ? safe(payload.message, 500) : undefined,
      needsRestart: !!payload.needsRestart,
    });
  }

  // Push the terminal's skills (user-authored + read-only package/project ones) to
  // the app's skills manager. Sent on request and after each create/delete/toggle.
  // `busy` drives a progress indicator; `needsRestart` tells the app a change only
  // reaches the model (the <available_skills> prompt block) on the next launch —
  // Run-now via /skill:name works immediately. NON-PII: names + descriptions +
  // coarse source only. Items bounded like sendExtensions.
  sendSkills(payload: {
    items: { name: string; description: string; source: string; editable: boolean; disabled: boolean }[];
    busy?: boolean;
    message?: string;
    needsRestart?: boolean;
  }): void {
    this.rawSend({
      type: "skills",
      items: payload.items.slice(0, 200).map((s) => ({
        name: safe(s.name, 200),
        description: safe(s.description, 1024),
        source: safe(s.source, 200),
        editable: !!s.editable,
        disabled: !!s.disabled,
      })),
      busy: !!payload.busy,
      message: payload.message ? safe(payload.message, 500) : undefined,
      needsRestart: !!payload.needsRestart,
    });
  }

  // Push the daemon's saved routines to the app's routines manager. Sent on request
  // and after each save/delete/pause/run. `busy` drives a progress indicator;
  // `message` carries a one-line result/error. Unlike the feed/webhook paths this is
  // the user's OWN config echoed back to their OWN app, so fields are size-clipped
  // (clip, NOT redactSecrets) to keep an edit round-tripping faithfully — a prompt
  // containing a literal "KEY=…" example must survive intact. List bounded like the
  // other managers.
  sendRoutines(payload: {
    items: {
      id: string;
      name: string;
      cron?: string;
      at?: string;
      prompt: string;
      cwd: string;
      model?: string;
      delivery: string[];
      tools?: string[];
      enabled: boolean;
      lastRun?: string;
      lastStatus?: "ok" | "error";
      lastError?: string;
      nextRun?: string;
    }[];
    busy?: boolean;
    message?: string;
  }): void {
    this.rawSend({
      type: "routines",
      items: payload.items.slice(0, 200).map((r) => ({
        id: r.id,
        name: clip(r.name, 200),
        cron: r.cron ? clip(r.cron, 200) : undefined,
        at: r.at ? clip(r.at, 64) : undefined,
        prompt: clip(r.prompt, 8000),
        cwd: clip(r.cwd, 1024),
        model: r.model ? clip(r.model, 200) : undefined,
        delivery: (r.delivery ?? []).slice(0, 20).map((d) => clip(String(d), 128)),
        tools: r.tools ? r.tools.slice(0, 100).map((t) => clip(String(t), 128)) : undefined,
        enabled: !!r.enabled,
        lastRun: r.lastRun,
        lastStatus: r.lastStatus,
        lastError: r.lastError ? clip(r.lastError, 1000) : undefined,
        nextRun: r.nextRun,
      })),
      busy: !!payload.busy,
      message: payload.message ? clip(payload.message, 500) : undefined,
    });
  }

  // Push the daemon's channel config to the app's channels manager. Sent on request
  // and after each save/remove. Like sendRoutines this is the user's OWN config
  // echoed to their OWN app — but a bot token NEVER crosses this wire: only
  // `secretsSet` (which secret fields are present, by NAME) is sent, so a relay /
  // server compromise can't lift a token from this frame. List bounded like the
  // other managers.
  sendChannels(payload: {
    items: {
      platform: string;
      configured: boolean;
      running: boolean;
      adminCount: number;
      memberCount: number;
      posture: string;
      tools: string[];
      model?: string;
      secretsSet: string[];
    }[];
    busy?: boolean;
    message?: string;
  }): void {
    this.rawSend({
      type: "channels",
      items: payload.items.slice(0, 20).map((c) => ({
        platform: clip(String(c.platform), 32),
        configured: !!c.configured,
        running: !!c.running,
        adminCount: Math.max(0, Math.floor(c.adminCount) || 0),
        memberCount: Math.max(0, Math.floor(c.memberCount) || 0),
        posture: clip(String(c.posture), 32),
        tools: (c.tools ?? []).slice(0, 100).map((t) => clip(String(t), 128)),
        model: c.model ? clip(c.model, 200) : undefined,
        secretsSet: (c.secretsSet ?? []).slice(0, 20).map((s) => clip(String(s), 64)),
      })),
      busy: !!payload.busy,
      message: payload.message ? clip(payload.message, 500) : undefined,
    });
  }

  // Push the host's MCP connectors to the app's MCP manager. Sent on request and after
  // each save/set_enabled/remove. Like sendChannels this is the user's OWN config echoed
  // to their OWN app — but an env VALUE (a token) NEVER crosses this wire: only `envKeys`
  // (names) and `secretsSet` (which of those are non-empty, by name) are sent, so a relay
  // / server compromise can't lift a credential from this frame. List bounded like the
  // other managers.
  sendMcp(payload: {
    items: {
      name: string;
      transport: string;
      enabled: boolean;
      command?: string;
      argsPreview?: string;
      url?: string;
      host?: string;
      oauth: boolean;
      envKeys: string[];
      secretsSet: string[];
    }[];
    busy?: boolean;
    message?: string;
  }): void {
    this.rawSend({
      type: "mcp",
      items: payload.items.slice(0, 50).map((m) => ({
        name: clip(String(m.name), 128),
        transport: m.transport === "http" ? "http" : "stdio",
        enabled: !!m.enabled,
        command: m.command ? clip(m.command, 200) : undefined,
        argsPreview: m.argsPreview ? clip(m.argsPreview, 500) : undefined,
        url: m.url ? clip(m.url, 500) : undefined,
        host: m.host ? clip(m.host, 200) : undefined,
        oauth: !!m.oauth,
        envKeys: (m.envKeys ?? []).slice(0, 30).map((k) => clip(String(k), 128)),
        secretsSet: (m.secretsSet ?? []).slice(0, 30).map((k) => clip(String(k), 128)),
      })),
      busy: !!payload.busy,
      message: payload.message ? clip(payload.message, 500) : undefined,
    });
  }

  // Push the daemon's saved workflows to the app's workflows manager as SUMMARIES (not
  // the full graphs — the editor fetches one at a time via sendWorkflow). Sent on request
  // and after each save/remove/run. The user's OWN config echoed to their OWN app, so
  // fields are clipped (not redacted). List bounded like the other managers.
  sendWorkflows(payload: {
    items: {
      id: string;
      name: string;
      description?: string;
      entryPoint: string;
      stepCount: number;
      gateCount: number;
      scriptCount: number;
    }[];
    busy?: boolean;
    message?: string;
  }): void {
    this.rawSend({
      type: "workflows",
      items: payload.items.slice(0, 200).map((w) => ({
        id: w.id,
        name: clip(w.name, 200),
        description: w.description ? clip(w.description, 1000) : undefined,
        entryPoint: clip(w.entryPoint, 64),
        stepCount: Math.max(0, Math.floor(w.stepCount) || 0),
        gateCount: Math.max(0, Math.floor(w.gateCount) || 0),
        scriptCount: Math.max(0, Math.floor(w.scriptCount) || 0),
      })),
      busy: !!payload.busy,
      message: payload.message ? clip(payload.message, 500) : undefined,
    });
  }

  // Push ONE full workflow graph to the app's editor (reply to workflows_get). The graph
  // is the user's own authored config, so it's sent whole (clipped only by the relay's
  // per-frame cap); `null` means the requested workflow wasn't found.
  sendWorkflow(workflow: unknown | null): void {
    this.rawSend({ type: "workflow", workflow: workflow ?? null });
  }

  // Ask the app to pick from a set of options — a CLI-initiated selection prompt.
  // The app renders the same picker as /model and replies with a select_response
  // (resolved by the bridge). Generic so any future prompt reuses one UI.
  requestSelect(
    id: string,
    req: { title: string; options: { value: string; label: string; hint?: string }[]; current?: string },
  ): void {
    this.rawSend({
      type: "select_request",
      id,
      title: safe(req.title, 200),
      options: req.options.slice(0, 500).map((o) => ({ value: o.value, label: safe(o.label, 200), hint: o.hint ? safe(o.hint, 200) : undefined })),
      current: req.current,
    });
  }

  // Ask the app for a line of free-form text — a CLI-initiated input prompt. The
  // app renders a text field and replies with an input_response (resolved by the
  // bridge). Companion to requestSelect for prompts that aren't a fixed choice.
  requestInput(
    id: string,
    req: { title: string; placeholder?: string },
  ): void {
    this.rawSend({
      type: "input_request",
      id,
      title: safe(req.title, 200),
      placeholder: req.placeholder ? safe(req.placeholder, 200) : undefined,
    });
  }

  requestApproval(id: string, req: PermissionRequest): void {
    this.rawSend({
      type: "approval_request",
      id,
      req: { tool: req.tool, kind: req.kind, title: req.title, detail: safe(req.detail, 4000), outside: !!req.outside },
    });
  }

  private bufferDelta(kind: "text" | "reasoning", text: string): void {
    if (this.bufKind && this.bufKind !== kind) this.flushDeltas();
    this.bufKind = kind;
    this.buf += text;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flushDeltas();
      }, TEXT_FLUSH_MS);
    }
  }

  private flushDeltas(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    if (this.bufKind && this.buf) {
      this.rawSend({ type: "event", event: { type: this.bufKind, text: this.buf } });
    }
    this.bufKind = null;
    this.buf = "";
  }
}
