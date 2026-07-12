// Telegram channel adapter — the least-friction platform to prototype: a bot token
// from @BotFather, plain HTTPS, long-poll `getUpdates` (no public endpoint, no
// gateway socket, no app review). Zero new dependencies — the Bot API is just JSON
// over fetch.
//
// This file is the ONLY platform-specific code. A Slack/Discord/WhatsApp adapter
// implements the same ChannelAdapter interface and reuses MessagingBridge verbatim.

import type { ChannelAdapter, InboundMessage } from "./types.ts";

const API = "https://api.telegram.org";
// Long-poll seconds we ask Telegram to hold the connection; the HTTP timeout below
// must exceed this or we'd cancel every idle poll.
const POLL_SECONDS = 50;
const POLL_HTTP_TIMEOUT_MS = (POLL_SECONDS + 10) * 1000;
const SEND_TIMEOUT_MS = 15_000;
const BACKOFF_MS = 3000;

// Shape of the bits of a Telegram Update we read.
interface TgUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: { id?: number | string };
    from?: { id?: number | string; username?: string; first_name?: string };
  };
}

// Pure mapping Update → normalized InboundMessage (null for non-text / malformed
// updates). Extracted so it's unit-testable without the polling loop.
export function messageFromUpdate(upd: TgUpdate): InboundMessage | null {
  const msg = upd.message;
  if (!msg || typeof msg.text !== "string") return null;
  const chatId = msg.chat?.id;
  if (chatId === undefined || chatId === null) return null;
  const from = msg.from;
  return {
    chatId: String(chatId),
    userId: String(from?.id ?? chatId),
    userName: from?.username || from?.first_name,
    text: msg.text,
  };
}

export interface TelegramOptions {
  botToken: string;
  fetchImpl?: typeof fetch;
  onLog?: (msg: string) => void;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram";
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onLog?: (msg: string) => void;
  private offset = 0; // next update_id to fetch from
  private running = false;
  private poll?: AbortController;

  constructor(opts: TelegramOptions) {
    this.token = opts.botToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onLog = opts.onLog;
  }

  async start(onMessage: (m: InboundMessage) => void): Promise<void> {
    if (this.running) return;
    this.running = true;
    void this.loop(onMessage);
  }

  stop(): void {
    this.running = false;
    this.poll?.abort();
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!text) return;
    await this.call("sendMessage", { chat_id: chatId, text }, SEND_TIMEOUT_MS);
  }

  sendTyping(chatId: string): void {
    // Best-effort; failures are cosmetic.
    void this.call("sendChatAction", { chat_id: chatId, action: "typing" }, 10_000).catch(() => {});
  }

  private log(msg: string): void {
    this.onLog?.(`telegram: ${msg}`);
  }

  private async loop(onMessage: (m: InboundMessage) => void): Promise<void> {
    while (this.running) {
      this.poll = new AbortController();
      try {
        const res = await this.call(
          "getUpdates",
          { timeout: POLL_SECONDS, offset: this.offset, allowed_updates: ["message"] },
          POLL_HTTP_TIMEOUT_MS,
          this.poll.signal,
        );
        const data = (await res.json()) as { ok?: boolean; result?: TgUpdate[]; description?: string };
        if (!data.ok) {
          this.log(`getUpdates not ok: ${data.description ?? "unknown"}`);
          await this.sleep(BACKOFF_MS);
          continue;
        }
        for (const upd of data.result ?? []) {
          this.offset = Math.max(this.offset, upd.update_id + 1);
          const m = messageFromUpdate(upd);
          if (m) onMessage(m);
        }
      } catch (e) {
        if (!this.running) break; // stop() aborted the poll — expected
        this.log(`poll error: ${e instanceof Error ? e.message : String(e)} — retrying`);
        await this.sleep(BACKOFF_MS);
      }
    }
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    extraSignal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = extraSignal ? AbortSignal.any([extraSignal, timeout]) : timeout;
    return this.fetchImpl(`${API}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
