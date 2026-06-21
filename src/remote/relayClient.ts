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
  // The app answered a relayed approval request.
  onApprovalResponse: (id: string, decision: "allow" | "deny") => void;
  // A controller attached — push a transcript snapshot so it can catch up.
  onControllerAttached: () => void;
  // Surface a one-line status/notice in the TUI.
  onStatus?: (text: string) => void;
}

const RECONNECT_MS = 3000;
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
  // Stable for this process so reconnects keep the same terminal identity.
  private readonly termId = randomUUID();
  private readonly label = terminalLabel();

  constructor(private readonly cb: RelayCallbacks) {}

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
    let frame: { type?: string; text?: string; id?: string; decision?: string };
    try {
      frame = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    this.debug(`recv ${frame.type}`);
    switch (frame.type) {
      case "prompt":
        if (typeof frame.text === "string" && frame.text.trim()) this.cb.onPrompt(frame.text);
        break;
      case "interrupt":
        this.cb.onInterrupt();
        break;
      case "approval_response":
        if (frame.id) this.cb.onApprovalResponse(frame.id, frame.decision === "deny" ? "deny" : "allow");
        break;
      case "controller_attached":
        this.cb.onControllerAttached();
        break;
    }
  }

  private rawSend(frame: unknown): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(frame)); } catch (_) { /* socket dying */ }
    }
  }

  // ── agent → controller ──────────────────────────────────────────────────────

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
