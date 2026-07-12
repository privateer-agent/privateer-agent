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
  // The app opened the extensions manager — reply with the current installed list
  // (a sendExtensions frame). Optional so pre-extensions callbacks keep compiling.
  onExtensionsList?: () => void;
  // The app asked to install a Pi extension by source spec (npm:/git:/path).
  onExtensionsAdd?: (source: string) => void;
  // The app asked to remove a previously-installed extension by source spec.
  onExtensionsRemove?: (source: string) => void;
  // The app opened the skills manager — reply with the current skills list
  // (a sendSkills frame). Optional so pre-skills callbacks keep compiling.
  onSkillsList?: () => void;
  // The app asked to create/overwrite a user skill (name + description + body).
  onSkillCreate?: (skill: { name: string; description: string; instructions: string }) => void;
  // The app asked to delete a user skill by name.
  onSkillDelete?: (name: string) => void;
  // The app toggled a user skill's model-invocation availability.
  onSkillSetEnabled?: (name: string, enabled: boolean) => void;
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
      case "extensions_list":
        this.cb.onExtensionsList?.();
        break;
      case "extensions_add":
        if (typeof frame.source === "string") this.cb.onExtensionsAdd?.(frame.source);
        break;
      case "extensions_remove":
        if (typeof frame.source === "string") this.cb.onExtensionsRemove?.(frame.source);
        break;
      case "skills_list":
        this.cb.onSkillsList?.();
        break;
      case "skills_create":
        if (typeof frame.name === "string") {
          this.cb.onSkillCreate?.({
            name: frame.name,
            description: typeof frame.description === "string" ? frame.description : "",
            instructions: typeof frame.instructions === "string" ? frame.instructions : "",
          });
        }
        break;
      case "skills_delete":
        if (typeof frame.name === "string") this.cb.onSkillDelete?.(frame.name);
        break;
      case "skills_set_enabled":
        if (typeof frame.name === "string") this.cb.onSkillSetEnabled?.(frame.name, frame.enabled === true);
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
  sendContext(ctx: { model?: string; version?: string }): void {
    const frame: Record<string, unknown> = { type: "context" };
    if (typeof ctx.model === "string" && ctx.model) frame.model = ctx.model;
    if (typeof ctx.version === "string" && ctx.version) frame.version = ctx.version;
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
