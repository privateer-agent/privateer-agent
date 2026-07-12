// Discord channel adapter — templated off the others against the same
// ChannelAdapter interface. Talks the Discord Gateway (a WebSocket) directly for
// receive and the REST API for send, so — like Telegram/Slack — it needs NO public
// inbound endpoint. Zero new dependencies: `ws` is already a dep (relayClient.ts)
// and REST is fetch.
//
// Discord app setup (one-time):
//   - Create a bot, copy its token → `botToken`.
//   - Enable the MESSAGE CONTENT intent (privileged) in the dev portal, else
//     `content` arrives empty.
//   - Invite the bot to your server, or DM it. `allowFrom` lists Discord user ids.
//
// Everything above the adapter (allowlist, serialization, redaction, chunking) is
// MessagingBridge, reused verbatim.

import WebSocket from "ws";
import type { ChannelAdapter, InboundMessage } from "./types.ts";

const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const API = "https://discord.com/api/v10";
const RECONNECT_MS = 3000;
const SEND_TIMEOUT_MS = 15_000;

// Gateway intent bits we need: guild messages, DMs, and (privileged) message
// content. https://discord.com/developers/docs/topics/gateway#gateway-intents
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_DIRECT_MESSAGES = 1 << 12;
const INTENT_MESSAGE_CONTENT = 1 << 15;
const DEFAULT_INTENTS = INTENT_GUILD_MESSAGES | INTENT_DIRECT_MESSAGES | INTENT_MESSAGE_CONTENT;

interface DiscordMessage {
  channel_id?: string;
  content?: string;
  author?: { id?: string; username?: string; bot?: boolean };
}

// Pure mapping: a MESSAGE_CREATE payload → normalized InboundMessage, or null.
// Drops messages from ANY bot (`author.bot`, which includes our own) so the agent
// never talks to itself. Extracted so it's unit-testable without the Gateway.
export function messageFromDiscord(d: DiscordMessage): InboundMessage | null {
  if (!d || !d.author || d.author.bot) return null;
  if (typeof d.content !== "string" || !d.content || !d.channel_id || !d.author.id) return null;
  return { chatId: d.channel_id, userId: d.author.id, userName: d.author.username, text: d.content };
}

export interface DiscordOptions {
  botToken: string;
  intents?: number;
  fetchImpl?: typeof fetch;
  onLog?: (msg: string) => void;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly name = "discord";
  private readonly token: string;
  private readonly intents: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onLog?: (msg: string) => void;
  private ws?: WebSocket;
  private running = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastSeq: number | null = null; // last dispatch sequence (for heartbeats)
  private acked = true; // did the server ack our last heartbeat? (zombie detection)
  private onMessage?: (m: InboundMessage) => void;

  constructor(opts: DiscordOptions) {
    this.token = opts.botToken;
    this.intents = opts.intents ?? DEFAULT_INTENTS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onLog = opts.onLog;
  }

  async start(onMessage: (m: InboundMessage) => void): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.onMessage = onMessage;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearHeartbeat();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!text) return;
    const res = await this.fetchImpl(`${API}/channels/${chatId}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) this.log(`create-message failed: HTTP ${res.status}`);
  }

  private log(msg: string): void {
    this.onLog?.(`discord: ${msg}`);
  }

  private connect(): void {
    if (!this.running) return;
    const ws = new WebSocket(GATEWAY);
    this.ws = ws;
    ws.on("message", (raw) => this.handleFrame(ws, raw));
    ws.on("close", () => {
      if (this.ws === ws) this.ws = undefined;
      this.clearHeartbeat();
      if (this.running) this.scheduleReconnect();
    });
    ws.on("error", (err: Error) => this.log(`ws error: ${err?.message ?? err}`));
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, RECONNECT_MS);
  }

  private handleFrame(ws: WebSocket, raw: WebSocket.RawData): void {
    let f: { op?: number; t?: string; s?: number | null; d?: any };
    try {
      f = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof f.s === "number") this.lastSeq = f.s;
    switch (f.op) {
      case 10: // Hello — begin heartbeating, then identify
        this.startHeartbeat(ws, f.d?.heartbeat_interval ?? 41_250);
        this.identify(ws);
        break;
      case 11: // Heartbeat ACK
        this.acked = true;
        break;
      case 1: // server requested a heartbeat now
        this.sendHeartbeat(ws);
        break;
      case 7: // Reconnect
      case 9: // Invalid Session — drop and re-identify fresh (no resume, for simplicity)
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        break;
      case 0: // Dispatch
        if (f.t === "MESSAGE_CREATE") {
          const m = messageFromDiscord(f.d);
          if (m) this.onMessage?.(m);
        }
        break;
    }
  }

  private identify(ws: WebSocket): void {
    this.send(ws, {
      op: 2,
      d: {
        token: this.token,
        intents: this.intents,
        properties: { os: "linux", browser: "privateer", device: "privateer" },
      },
    });
  }

  private startHeartbeat(ws: WebSocket, intervalMs: number): void {
    this.clearHeartbeat();
    this.acked = true;
    this.heartbeat = setInterval(() => {
      if (!this.acked) {
        // No ACK since the last beat → zombie connection; drop it to reconnect.
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.sendHeartbeat(ws);
    }, intervalMs);
  }

  private sendHeartbeat(ws: WebSocket): void {
    this.acked = false;
    this.send(ws, { op: 1, d: this.lastSeq });
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private send(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* socket dying */
    }
  }
}
