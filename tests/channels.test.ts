import { test } from "node:test";
import assert from "node:assert/strict";
import { MessagingBridge, chunkText, approvalDecision, type TurnRunner } from "../src/channels/bridge.ts";
import { messageFromUpdate, TelegramAdapter } from "../src/channels/telegram.ts";
import { messageFromSlackEvent, SlackAdapter } from "../src/channels/slack.ts";
import { messageFromDiscord, DiscordAdapter } from "../src/channels/discord.ts";
import { messagesFromWebhook, WhatsAppAdapter } from "../src/channels/whatsapp.ts";
import type { ChannelAdapter, InboundMessage } from "../src/channels/types.ts";

// A fake adapter standing in for a platform: it captures the bridge's onMessage
// handler (so tests can inject inbound messages) and records everything sent.
function makeFakeAdapter() {
  let handler: ((m: InboundMessage) => void) | undefined;
  const sent: { chatId: string; text: string }[] = [];
  const typing: string[] = [];
  const adapter: ChannelAdapter & {
    inject(m: InboundMessage): void;
    sent: typeof sent;
    typing: typeof typing;
  } = {
    name: "fake",
    async start(onMessage) {
      handler = onMessage;
    },
    async sendText(chatId, text) {
      sent.push({ chatId, text });
    },
    sendTyping(chatId) {
      typing.push(chatId);
    },
    stop() {},
    inject(m) {
      handler?.(m);
    },
    sent,
    typing,
  };
  return adapter;
}

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  chatId: "c1",
  userId: "u1",
  text: "hello",
  ...over,
});

// Let the per-chat promise tail flush.
const settle = () => new Promise((r) => setTimeout(r, 0));

test("authorized message runs a turn and replies with the (redacted) output", async () => {
  const adapter = makeFakeAdapter();
  const runTurn: TurnRunner = async (_chat, text, onText) => {
    onText(`echo: ${text} secret=abc123`);
    return { ok: true };
  };
  const bridge = new MessagingBridge({
    adapter,
    runTurn,
    isAllowed: (m) => m.userId === "u1",
    isAdmin: (m) => m.userId === "u1",
    redact: (t) => t.replace(/secret=\S+/g, "secret=[redacted]"),
  });
  await bridge.start();

  adapter.inject(msg({ text: "hi there" }));
  await settle();

  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0].chatId, "c1");
  assert.equal(adapter.sent[0].text, "echo: hi there secret=[redacted]");
  assert.deepEqual(adapter.typing, ["c1"]); // typing indicator fired
});

test("unauthorized sender is ignored silently — no turn, no reply", async () => {
  const adapter = makeFakeAdapter();
  let ran = false;
  const bridge = new MessagingBridge({
    adapter,
    runTurn: async () => {
      ran = true;
      return { ok: true };
    },
    isAllowed: (m) => m.userId === "owner",
    isAdmin: () => false,
  });
  await bridge.start();

  adapter.inject(msg({ userId: "stranger" }));
  await settle();

  assert.equal(ran, false);
  assert.equal(adapter.sent.length, 0);
});

test("turns in the same chat are serialized (no interleaving)", async () => {
  const adapter = makeFakeAdapter();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((r) => (releaseFirst = r));

  const runTurn: TurnRunner = async (_chat, text, onText) => {
    order.push(`start:${text}`);
    if (text === "first") await firstGate; // hold the first turn open
    order.push(`end:${text}`);
    onText(`done ${text}`);
    return { ok: true };
  };
  const bridge = new MessagingBridge({ adapter, runTurn, isAllowed: () => true, isAdmin: () => true });
  await bridge.start();

  adapter.inject(msg({ text: "first" }));
  adapter.inject(msg({ text: "second" }));
  await settle();

  // Second must not have started while first is still running.
  assert.deepEqual(order, ["start:first"]);
  releaseFirst();
  await settle();
  await settle();
  assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second"]);
});

test("a failing turn surfaces an error line (plus any partial text)", async () => {
  const adapter = makeFakeAdapter();
  const runTurn: TurnRunner = async (_chat, _text, onText) => {
    onText("partial answer");
    return { ok: false, error: "model exploded" };
  };
  const bridge = new MessagingBridge({ adapter, runTurn, isAllowed: () => true, isAdmin: () => true });
  await bridge.start();

  adapter.inject(msg());
  await settle();

  assert.equal(adapter.sent.length, 2);
  assert.equal(adapter.sent[0].text, "partial answer");
  assert.match(adapter.sent[1].text, /model exploded/);
});

test("/stop aborts the in-flight turn's signal", async () => {
  const adapter = makeFakeAdapter();
  let aborted = false;
  let releaseTurn!: () => void;
  const gate = new Promise<void>((r) => (releaseTurn = r));
  const runTurn: TurnRunner = async (_chat, _text, _onText, signal) => {
    signal.addEventListener("abort", () => (aborted = true));
    await gate;
    return { ok: true };
  };
  const bridge = new MessagingBridge({ adapter, runTurn, isAllowed: () => true, isAdmin: () => true });
  await bridge.start();

  adapter.inject(msg({ text: "do work" }));
  await settle();
  adapter.inject(msg({ text: "/stop" }));
  await settle();

  assert.equal(aborted, true);
  releaseTurn();
  await settle();
});

// ── interactive approval (in-chat yes/no) ───────────────────────────────────────

const gatedTurn =
  (getBridge: () => MessagingBridge, record: (d: string) => void): TurnRunner =>
  async (chatId, _text, onText, signal) => {
    const decision = await getBridge().requestApproval(
      chatId,
      { kind: "bash", title: "Run command", detail: "ls -la" },
      signal,
    );
    record(decision);
    onText(`ran (${decision})`);
    return { ok: true };
  };

test("a gated action prompts in-chat and a 'yes' reply allows it", async () => {
  const adapter = makeFakeAdapter();
  let decision: string | undefined;
  let bridge!: MessagingBridge;
  bridge = new MessagingBridge({
    adapter,
    runTurn: gatedTurn(() => bridge, (d) => (decision = d)),
    isAllowed: () => true,
    isAdmin: () => true,
  });
  await bridge.start();

  adapter.inject(msg({ text: "list files" }));
  await settle();
  // Approval prompt sent; the turn is suspended awaiting a reply.
  assert.equal(adapter.sent.length, 1);
  assert.match(adapter.sent[0].text, /Approval needed/);
  assert.equal(decision, undefined);

  adapter.inject(msg({ text: "yes" }));
  await settle();
  assert.equal(decision, "allow");
  assert.ok(adapter.sent.some((s) => s.text === "ran (allow)"));
});

test("a 'no' reply denies the gated action", async () => {
  const adapter = makeFakeAdapter();
  let decision: string | undefined;
  let bridge!: MessagingBridge;
  bridge = new MessagingBridge({
    adapter,
    runTurn: gatedTurn(() => bridge, (d) => (decision = d)),
    isAllowed: () => true,
    isAdmin: () => true,
  });
  await bridge.start();

  adapter.inject(msg({ text: "list files" }));
  await settle();
  adapter.inject(msg({ text: "no" }));
  await settle();
  assert.equal(decision, "deny");
});

test("an ambiguous reply re-prompts and keeps the approval pending", async () => {
  const adapter = makeFakeAdapter();
  let decision: string | undefined;
  let bridge!: MessagingBridge;
  bridge = new MessagingBridge({
    adapter,
    runTurn: gatedTurn(() => bridge, (d) => (decision = d)),
    isAllowed: () => true,
    isAdmin: () => true,
  });
  await bridge.start();

  adapter.inject(msg({ text: "list files" }));
  await settle();
  adapter.inject(msg({ text: "maybe?" }));
  await settle();
  assert.equal(decision, undefined); // still pending
  assert.ok(adapter.sent.some((s) => /Reply "yes" to allow/.test(s.text)));

  adapter.inject(msg({ text: "y" }));
  await settle();
  assert.equal(decision, "allow");
});

test("requestApproval fails closed (deny) on abort", async () => {
  const adapter = makeFakeAdapter();
  const bridge = new MessagingBridge({ adapter, runTurn: async () => ({ ok: true }), isAllowed: () => true, isAdmin: () => true });
  const ac = new AbortController();
  const p = bridge.requestApproval("c1", { kind: "bash", title: "Run", detail: "x" }, ac.signal);
  ac.abort();
  assert.equal(await p, "deny");
});

test("the approval prompt is redacted before it leaves the machine", async () => {
  const adapter = makeFakeAdapter();
  const bridge = new MessagingBridge({
    adapter,
    runTurn: async () => ({ ok: true }),
    isAllowed: () => true,
    isAdmin: () => true,
    redact: (t) => t.replace(/TOKEN=\S+/g, "TOKEN=[redacted]"),
  });
  const ac = new AbortController();
  const p = bridge.requestApproval("c1", { kind: "bash", title: "Run", detail: "curl -H TOKEN=abc123" }, ac.signal);
  await settle();
  assert.match(adapter.sent[0].text, /TOKEN=\[redacted\]/);
  ac.abort(); // clear the pending approval's timer so the test loop can exit
  await p;
});

test("approvalDecision maps yes/no variants and rejects ambiguity", () => {
  for (const y of ["yes", "Y", "allow", "ok", "👍"]) assert.equal(approvalDecision(y), "allow");
  for (const n of ["no", "N", "deny", "cancel", "👎"]) assert.equal(approvalDecision(n), "deny");
  for (const a of ["maybe", "run it", ""]) assert.equal(approvalDecision(a), null);
});

// ── roles: admin vs member ──────────────────────────────────────────────────────

test("runTurn receives the triggering user's admin role", async () => {
  const adapter = makeFakeAdapter();
  const seen: { user: string; isAdmin: boolean }[] = [];
  const runTurn: TurnRunner = async (_c, _t, onText, _s, meta) => {
    seen.push({ user: meta.userId, isAdmin: meta.isAdmin });
    onText("ok");
    return { ok: true };
  };
  const bridge = new MessagingBridge({
    adapter,
    runTurn,
    isAllowed: () => true,
    isAdmin: (m) => m.userId === "admin",
  });
  await bridge.start();

  adapter.inject(msg({ userId: "admin", text: "a" }));
  await settle();
  adapter.inject(msg({ userId: "member", text: "b" }));
  await settle();
  assert.deepEqual(seen, [
    { user: "admin", isAdmin: true },
    { user: "member", isAdmin: false },
  ]);
});

test("only an admin can answer an approval; a member's reply is refused", async () => {
  const adapter = makeFakeAdapter();
  let decision: string | undefined;
  let bridge!: MessagingBridge;
  bridge = new MessagingBridge({
    adapter,
    runTurn: gatedTurn(() => bridge, (d) => (decision = d)),
    isAllowed: () => true, // both may chat
    isAdmin: (m) => m.userId === "admin",
  });
  await bridge.start();

  adapter.inject(msg({ userId: "admin", text: "list files" }));
  await settle();
  // A member tries to approve → refused, approval stays pending.
  adapter.inject(msg({ userId: "member", text: "yes" }));
  await settle();
  assert.equal(decision, undefined);
  assert.ok(adapter.sent.some((s) => /Only an admin can approve/.test(s.text)));
  // The admin approves → resolves.
  adapter.inject(msg({ userId: "admin", text: "yes" }));
  await settle();
  assert.equal(decision, "allow");
});

test("audit sink records prompt, approval_request, and approval_decision", async () => {
  const adapter = makeFakeAdapter();
  const events: { event: string; role?: string }[] = [];
  let bridge!: MessagingBridge;
  bridge = new MessagingBridge({
    adapter,
    runTurn: gatedTurn(() => bridge, () => {}),
    isAllowed: () => true,
    isAdmin: () => true,
    onAudit: (e) => events.push(e),
  });
  await bridge.start();

  adapter.inject(msg({ text: "list files" }));
  await settle();
  adapter.inject(msg({ text: "yes" }));
  await settle();

  const kinds = events.map((e) => e.event);
  assert.ok(kinds.includes("prompt"));
  assert.ok(kinds.includes("approval_request"));
  assert.ok(kinds.includes("approval_decision"));
});

test("chunkText splits long text under the cap, preferring newlines", () => {
  const line = "x".repeat(500);
  const text = [line, line, line, line, line].join("\n"); // ~2504 chars
  const chunks = chunkText(text, 1900);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 1900, `chunk length ${c.length}`);
  // Round-trips (modulo the newlines consumed at split points).
  assert.equal(chunks.join("\n").replace(/\n+/g, "\n"), text.replace(/\n+/g, "\n"));
});

// ── Telegram platform mapping (the only platform-specific logic) ────────────────

test("messageFromUpdate normalizes a text message", () => {
  const m = messageFromUpdate({
    update_id: 10,
    message: { text: "hi", chat: { id: 42 }, from: { id: 7, username: "alice" } },
  });
  assert.deepEqual(m, { chatId: "42", userId: "7", userName: "alice", text: "hi" });
});

test("messageFromUpdate ignores non-text / malformed updates", () => {
  assert.equal(messageFromUpdate({ update_id: 1, message: { chat: { id: 1 } } }), null);
  assert.equal(messageFromUpdate({ update_id: 2 }), null);
});

test("TelegramAdapter.sendText posts to the Bot API with the right shape", async () => {
  const calls: { url: string; body: any }[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as unknown as typeof fetch;

  const adapter = new TelegramAdapter({ botToken: "T0KEN", fetchImpl: fakeFetch });
  await adapter.sendText("99", "hello world");

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/botT0KEN\/sendMessage$/);
  assert.deepEqual(calls[0].body, { chat_id: "99", text: "hello world" });
});

// ── Slack platform mapping (its only platform-specific logic) ───────────────────

test("messageFromSlackEvent normalizes a user message event", () => {
  const m = messageFromSlackEvent({
    event: { type: "message", user: "U123", text: "hi", channel: "D456" },
  });
  assert.deepEqual(m, { chatId: "D456", userId: "U123", text: "hi" });
});

test("messageFromSlackEvent ignores bot echoes, edits, and non-message events", () => {
  // Our own bot's message → must be dropped to avoid a loop.
  assert.equal(
    messageFromSlackEvent({ event: { type: "message", bot_id: "B1", text: "x", channel: "C", user: "U" } }),
    null,
  );
  // Edited/system message (has a subtype).
  assert.equal(
    messageFromSlackEvent({ event: { type: "message", subtype: "message_changed", text: "x", channel: "C", user: "U" } }),
    null,
  );
  // Not a message event.
  assert.equal(messageFromSlackEvent({ event: { type: "reaction_added", user: "U" } }), null);
  assert.equal(messageFromSlackEvent({}), null);
});

test("SlackAdapter.sendText posts to chat.postMessage with auth + right shape", async () => {
  const calls: { url: string; auth?: string; body: any }[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, auth: init.headers?.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;

  const adapter = new SlackAdapter({ appToken: "xapp-1", botToken: "xoxb-1", fetchImpl: fakeFetch });
  await adapter.sendText("D456", "hello world");

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/chat\.postMessage$/);
  assert.equal(calls[0].auth, "Bearer xoxb-1");
  assert.deepEqual(calls[0].body, { channel: "D456", text: "hello world" });
});

// ── Discord platform mapping (Gateway MESSAGE_CREATE) ───────────────────────────

test("messageFromDiscord normalizes a user message", () => {
  const m = messageFromDiscord({
    channel_id: "C1",
    content: "hi",
    author: { id: "U9", username: "bob", bot: false },
  });
  assert.deepEqual(m, { chatId: "C1", userId: "U9", userName: "bob", text: "hi" });
});

test("messageFromDiscord ignores bot authors and empty content", () => {
  assert.equal(
    messageFromDiscord({ channel_id: "C1", content: "x", author: { id: "B", bot: true } }),
    null,
  );
  assert.equal(messageFromDiscord({ channel_id: "C1", content: "", author: { id: "U" } }), null);
  assert.equal(messageFromDiscord({ content: "x", author: { id: "U" } }), null);
});

test("DiscordAdapter.sendText posts to channels/:id/messages with Bot auth", async () => {
  const calls: { url: string; auth?: string; body: any }[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, auth: init.headers?.authorization, body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const adapter = new DiscordAdapter({ botToken: "TOK", fetchImpl: fakeFetch });
  await adapter.sendText("C1", "hello world");

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/channels\/C1\/messages$/);
  assert.equal(calls[0].auth, "Bot TOK");
  assert.deepEqual(calls[0].body, { content: "hello world" });
});

// ── WhatsApp platform mapping (Cloud API webhook) ───────────────────────────────

test("messagesFromWebhook extracts text messages and ignores the rest", () => {
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: "15551234567", type: "text", text: { body: "hello" } },
                { from: "15551234567", type: "image" }, // non-text → ignored
              ],
            },
          },
          { value: { statuses: [{ status: "delivered" }] } as any }, // receipts → ignored
        ],
      },
    ],
  };
  assert.deepEqual(messagesFromWebhook(body), [
    { chatId: "15551234567", userId: "15551234567", text: "hello" },
  ]);
  assert.deepEqual(messagesFromWebhook({}), []);
});

test("WhatsAppAdapter.sendText posts to the Graph API with the right shape", async () => {
  const calls: { url: string; auth?: string; body: any }[] = [];
  const fakeFetch = (async (url: string, init: any) => {
    calls.push({ url, auth: init.headers?.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ messages: [{ id: "wamid" }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const adapter = new WhatsAppAdapter({
    phoneNumberId: "PN1",
    accessToken: "AT1",
    verifyToken: "V1",
    fetchImpl: fakeFetch,
  });
  await adapter.sendText("15551234567", "hello world");

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/PN1\/messages$/);
  assert.equal(calls[0].auth, "Bearer AT1");
  assert.deepEqual(calls[0].body, {
    messaging_product: "whatsapp",
    to: "15551234567",
    type: "text",
    text: { body: "hello world" },
  });
});
