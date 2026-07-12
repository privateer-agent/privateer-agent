// Slack channel adapter — templated off the Telegram one against the same
// ChannelAdapter interface. Uses Socket Mode (an outbound WebSocket), so like
// Telegram long-poll it needs NO public inbound endpoint: it works from a laptop
// behind NAT. Zero new dependencies — `ws` is already a dep (see relayClient.ts)
// and the rest is the Slack Web API over fetch.
//
// Slack app setup (one-time):
//   - Enable Socket Mode → generate an app-level token `xapp-…` (scope
//     connections:write). That's `appToken`.
//   - Bot token `xoxb-…` with scope `chat:write`. That's `botToken`.
//   - Event Subscriptions → subscribe the bot to `message.im` (DMs). Then DM the bot.
//
// Everything above the adapter (allowlist, serialization, redaction, chunking) is
// MessagingBridge, reused verbatim.

import WebSocket from "ws";
import type { ChannelAdapter, InboundMessage } from "./types.ts";

const API = "https://slack.com/api";
const RECONNECT_MS = 3000;
const HTTP_TIMEOUT_MS = 15_000;

// The Events-API payload we read (Socket Mode wraps this in an envelope).
interface SlackEventPayload {
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    text?: string;
    channel?: string;
  };
}

// Pure mapping: an Events-API payload → normalized InboundMessage, or null for
// anything we shouldn't treat as a user prompt. Critically filters out our own
// bot's messages (`bot_id`) and non-plain events (`subtype`: edits, joins, etc.)
// so the agent never talks to itself. Extracted so it's unit-testable.
export function messageFromSlackEvent(payload: SlackEventPayload): InboundMessage | null {
  const ev = payload.event;
  if (!ev || ev.type !== "message") return null;
  if (ev.bot_id || ev.subtype) return null; // bot echoes / edits / system messages
  if (typeof ev.text !== "string" || !ev.channel || !ev.user) return null;
  return { chatId: ev.channel, userId: ev.user, text: ev.text };
}

export interface SlackOptions {
  appToken: string; // xapp-… (Socket Mode connection)
  botToken: string; // xoxb-… (chat:write)
  fetchImpl?: typeof fetch;
  onLog?: (msg: string) => void;
}

export class SlackAdapter implements ChannelAdapter {
  readonly name = "slack";
  private readonly appToken: string;
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onLog?: (msg: string) => void;
  private ws?: WebSocket;
  private running = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private onMessage?: (m: InboundMessage) => void;

  constructor(opts: SlackOptions) {
    this.appToken = opts.appToken;
    this.botToken = opts.botToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onLog = opts.onLog;
  }

  async start(onMessage: (m: InboundMessage) => void): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.onMessage = onMessage;
    await this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!text) return;
    const res = await this.web("chat.postMessage", { channel: chatId, text });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!data.ok) this.log(`chat.postMessage failed: ${data.error ?? "unknown"}`);
  }

  // Slack has no bot "typing" over the Web API, so sendTyping is intentionally
  // absent — the bridge guards `sendTyping?.()`.

  private log(msg: string): void {
    this.onLog?.(`slack: ${msg}`);
  }

  // Mint a fresh Socket Mode WSS URL and connect. Slack rotates the URL, sending a
  // `disconnect` frame before it does; we just reconnect (re-minting) each time.
  private async connect(): Promise<void> {
    if (!this.running) return;
    let url: string;
    try {
      const res = await this.web("apps.connections.open", {}, this.appToken);
      const data = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      if (!data.ok || !data.url) throw new Error(data.error ?? "no url");
      url = data.url;
    } catch (e) {
      this.log(`apps.connections.open failed: ${e instanceof Error ? e.message : String(e)} — retrying`);
      return this.scheduleReconnect();
    }

    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("message", (raw) => this.handleFrame(ws, raw));
    ws.on("close", () => {
      if (this.ws === ws) this.ws = undefined;
      if (this.running) this.scheduleReconnect();
    });
    ws.on("error", (err: Error) => this.log(`ws error: ${err?.message ?? err}`));
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, RECONNECT_MS);
  }

  private handleFrame(ws: WebSocket, raw: WebSocket.RawData): void {
    let frame: { type?: string; envelope_id?: string; payload?: SlackEventPayload };
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Ack EVERY envelope immediately (Slack retries if not acked within 3s), before
    // doing any work — onMessage only queues an async turn.
    if (frame.envelope_id) {
      try {
        ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
      } catch {
        /* socket dying */
      }
    }
    if (frame.type === "disconnect") {
      // URL refresh / server drain — drop this socket; `close` reconnects.
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }
    if (frame.type === "events_api" && frame.payload) {
      const m = messageFromSlackEvent(frame.payload);
      if (m) this.onMessage?.(m);
    }
  }

  private async web(method: string, body: Record<string, unknown>, token = this.botToken): Promise<Response> {
    return this.fetchImpl(`${API}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  }
}
