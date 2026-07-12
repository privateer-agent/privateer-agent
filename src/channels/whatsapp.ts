// WhatsApp channel adapter — the official Meta Cloud API. Unlike the socket/
// long-poll adapters, Cloud API delivers inbound messages by POSTing to a webhook,
// so this adapter is the INBOUND-WEBHOOK shape: start() runs a small HTTP listener
// (Node's built-in `http`, zero new deps) and sends via the Graph API over fetch.
//
// TRADEOFF: a webhook needs a PUBLIC HTTPS URL for Meta to reach — so unlike the
// others this can't run purely behind NAT. Expose the port with a tunnel
// (cloudflared / ngrok) or host it, and register that URL + the verify token in the
// Meta app's webhook config. This is inherent to the Cloud API, not the adapter.
//
// Meta app setup (one-time):
//   - WhatsApp product → note the phone number id → `phoneNumberId`, and a
//     (system-user) access token → `accessToken`.
//   - Webhooks → callback URL = https://<your-tunnel>/webhook, verify token =
//     whatever you set as `verifyToken`; subscribe to the `messages` field.
//   - Optional but recommended: set `appSecret` to verify Meta's X-Hub-Signature-256.
//
// Everything above the adapter (allowlist, serialization, redaction, chunking) is
// MessagingBridge, reused verbatim.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelAdapter, InboundMessage } from "./types.ts";

const GRAPH = "https://graph.facebook.com/v21.0";
const SEND_TIMEOUT_MS = 15_000;

interface WaWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        // Inbound user messages. (Delivery/read receipts arrive under `statuses`,
        // which we deliberately ignore.)
        messages?: Array<{ from?: string; type?: string; text?: { body?: string } }>;
      };
    }>;
  }>;
}

// Pure mapping: a webhook POST body → the text messages it carries. A single POST
// can batch several. Non-text messages and status callbacks yield nothing.
// Extracted so it's unit-testable without an HTTP server.
export function messagesFromWebhook(body: WaWebhookBody): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        if (msg.type !== "text") continue;
        const text = msg.text?.body;
        if (!msg.from || typeof text !== "string") continue;
        // The sender's phone number is both the conversation and the user id.
        out.push({ chatId: msg.from, userId: msg.from, text });
      }
    }
  }
  return out;
}

export interface WhatsAppOptions {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  appSecret?: string; // enables X-Hub-Signature-256 verification when set
  port?: number;
  path?: string;
  fetchImpl?: typeof fetch;
  onLog?: (msg: string) => void;
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly name = "whatsapp";
  private readonly opts: WhatsAppOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly onLog?: (msg: string) => void;
  private readonly port: number;
  private readonly path: string;
  private server?: Server;
  private onMessage?: (m: InboundMessage) => void;

  constructor(opts: WhatsAppOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onLog = opts.onLog;
    this.port = opts.port ?? 8787;
    this.path = opts.path ?? "/webhook";
  }

  async start(onMessage: (m: InboundMessage) => void): Promise<void> {
    this.onMessage = onMessage;
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(this.port, () => resolve()));
    this.log(`webhook listening on :${this.port}${this.path} — expose it publicly for Meta to reach.`);
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!text) return;
    const res = await this.fetchImpl(`${GRAPH}/${this.opts.phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: chatId, type: "text", text: { body: text } }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) this.log(`send failed: HTTP ${res.status}`);
  }

  private log(msg: string): void {
    this.onLog?.(`whatsapp: ${msg}`);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    if (url.pathname !== this.path) {
      res.writeHead(404);
      res.end();
      return;
    }

    // GET: Meta's one-time verification challenge.
    if (req.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge") ?? "";
      if (mode === "subscribe" && token === this.opts.verifyToken) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(challenge);
      } else {
        res.writeHead(403);
        res.end();
      }
      return;
    }

    // POST: an inbound message batch.
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (!this.verifySignature(req, raw)) {
          this.log("rejected webhook: bad or missing X-Hub-Signature-256");
          res.writeHead(401);
          res.end();
          return;
        }
        // Ack fast — Meta retries the delivery on any non-200.
        res.writeHead(200);
        res.end();
        let body: WaWebhookBody;
        try {
          body = JSON.parse(raw);
        } catch {
          return;
        }
        for (const m of messagesFromWebhook(body)) this.onMessage?.(m);
      });
      return;
    }

    res.writeHead(405);
    res.end();
  }

  // Verify Meta's HMAC signature when an app secret is configured. Absent → skipped
  // (documented tradeoff); the allowlist still gates who may drive the agent.
  private verifySignature(req: IncomingMessage, raw: string): boolean {
    if (!this.opts.appSecret) return true;
    const header = req.headers["x-hub-signature-256"];
    if (typeof header !== "string") return false;
    const expected = "sha256=" + createHmac("sha256", this.opts.appSecret).update(raw).digest("hex");
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
