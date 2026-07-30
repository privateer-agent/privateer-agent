import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MessagingBridge,
  chunkText,
  approvalDecision,
  passesMentionGate,
  promptWithAttachments,
  type TurnRunner,
} from "../src/channels/bridge.ts";
import { messageFromUpdate, TelegramAdapter } from "../src/channels/telegram.ts";
import { messageFromSlackEvent, SlackAdapter } from "../src/channels/slack.ts";
import { messageFromDiscord, DiscordAdapter } from "../src/channels/discord.ts";
import { messagesFromWebhook, WhatsAppAdapter } from "../src/channels/whatsapp.ts";
import type { ChannelAdapter, InboundMessage, SendOptions } from "../src/channels/types.ts";

// A fake adapter standing in for a platform: it captures the bridge's onMessage
// handler (so tests can inject inbound messages) and records everything sent.
function makeFakeAdapter(opts: { maxMessageBytes?: number; assignIds?: boolean } = {}) {
  let handler: ((m: InboundMessage) => void) | undefined;
  const sent: { chatId: string; text: string; opts?: SendOptions }[] = [];
  const typing: string[] = [];
  let seq = 0;
  const adapter: ChannelAdapter & {
    inject(m: InboundMessage): void;
    sent: typeof sent;
    typing: typeof typing;
  } = {
    name: "fake",
    maxMessageBytes: opts.maxMessageBytes,
    async start(onMessage) {
      handler = onMessage;
    },
    async sendText(chatId, text, sendOpts) {
      sent.push({ chatId, text, opts: sendOpts });
      // Platforms that hand back the id of what they just wrote let the bridge chain
      // subsequent chunks beneath it.
      return opts.assignIds ? `sent-${++seq}` : undefined;
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

test("chunkText measures BYTES, not characters, and never splits a code point", () => {
  // 400 four-byte emoji = 1600 bytes but only 800 UTF-16 units — a char-based cap
  // would wave this through and the platform would reject it.
  const text = "😀".repeat(400);
  const chunks = chunkText(text, 500);
  assert.ok(chunks.length >= 4, `expected several chunks, got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c) <= 500, `chunk was ${Buffer.byteLength(c)} bytes`);
    // A split surrogate pair shows up as U+FFFD once re-encoded.
    assert.ok(!c.includes("�"), "chunk split a code point");
  }
  assert.equal(chunks.join(""), text);
});

// ── the mention gate ───────────────────────────────────────────────────────────

test("passesMentionGate: off lets everything through", () => {
  assert.equal(passesMentionGate(msg(), "off"), true);
  assert.equal(passesMentionGate(msg(), undefined), true);
});

test("passesMentionGate: mention requires being addressed; DMs need mention-or-dm", () => {
  assert.equal(passesMentionGate(msg({ mentionsMe: true }), "mention"), true);
  assert.equal(passesMentionGate(msg({ mentionsMe: false }), "mention"), false);
  // A DM is inherently addressed to the agent, but only "mention-or-dm" says so.
  assert.equal(passesMentionGate(msg({ isDirect: true }), "mention"), false);
  assert.equal(passesMentionGate(msg({ isDirect: true }), "mention-or-dm"), true);
  assert.equal(passesMentionGate(msg({ mentionsMe: true }), "mention-or-dm"), true);
  assert.equal(passesMentionGate(msg(), "mention-or-dm"), false);
});

test("passesMentionGate FAILS CLOSED when the adapter can't report mentions", () => {
  // Enabling a gate on a platform that can't honour it must silence the bot, not
  // silently defeat the gate and answer everything.
  assert.equal(passesMentionGate(msg({ mentionsMe: undefined }), "mention"), false);
});

test("mention gate drops an unaddressed message but still runs an addressed one", async () => {
  const adapter = makeFakeAdapter();
  let turns = 0;
  const bridge = new MessagingBridge({
    adapter,
    runTurn: async (_c, _t, onText) => {
      turns++;
      onText("hi");
      return { ok: true };
    },
    isAllowed: () => true,
    isAdmin: () => true,
    mentionGate: "mention",
  });
  await bridge.start();

  adapter.inject(msg({ text: "just chatting to someone else" }));
  await settle();
  assert.equal(turns, 0);
  assert.equal(adapter.sent.length, 0, "an ungated bot must stay completely silent");

  adapter.inject(msg({ text: "@agent hello", mentionsMe: true }));
  await settle();
  assert.equal(turns, 1);
});

test("the mention gate NEVER blocks an approval reply or /stop", async () => {
  // Ordering regression guard: both arrive without an @mention. Gating the approval
  // answer would hang the waiting turn until its 2-minute fail-closed timeout, and
  // gating /stop would make the channel uninterruptible.
  const adapter = makeFakeAdapter();
  let decision: string | undefined;
  const bridge = new MessagingBridge({
    adapter,
    runTurn: async (chatId, _t, _onText, signal) => {
      decision = await bridge.requestApproval(chatId, { kind: "bash", title: "run", detail: "ls" }, signal);
      return { ok: true };
    },
    isAllowed: () => true,
    isAdmin: () => true,
    mentionGate: "mention",
  });
  await bridge.start();

  adapter.inject(msg({ text: "@agent do it", mentionsMe: true }));
  await settle();
  adapter.inject(msg({ text: "yes" })); // no mention — must still be heard
  await settle();
  assert.equal(decision, "allow");
});

// ── threading ──────────────────────────────────────────────────────────────────

test("the reply attaches to the message that triggered it", async () => {
  const adapter = makeFakeAdapter();
  const bridge = new MessagingBridge({
    adapter,
    runTurn: async (_c, _t, onText) => {
      onText("answer");
      return { ok: true };
    },
    isAllowed: () => true,
    isAdmin: () => true,
  });
  await bridge.start();
  adapter.inject(msg({ messageId: "evt-1", threadRootId: "root-1" }));
  await settle();
  assert.deepEqual(adapter.sent[0].opts, { replyTo: "evt-1", threadRoot: "root-1" });
});

test("a message with no thread root roots the thread at itself", async () => {
  const adapter = makeFakeAdapter();
  const bridge = new MessagingBridge({
    adapter,
    runTurn: async (_c, _t, onText) => {
      onText("answer");
      return { ok: true };
    },
    isAllowed: () => true,
    isAdmin: () => true,
  });
  await bridge.start();
  adapter.inject(msg({ messageId: "evt-1" }));
  await settle();
  assert.deepEqual(adapter.sent[0].opts, { replyTo: "evt-1", threadRoot: "evt-1" });
});

test("multi-chunk answers chain beneath the previous chunk when the adapter returns ids", async () => {
  const adapter = makeFakeAdapter({ maxMessageBytes: 50, assignIds: true });
  const bridge = new MessagingBridge({
    adapter,
    runTurn: async (_c, _t, onText) => {
      onText("y".repeat(180));
      return { ok: true };
    },
    isAllowed: () => true,
    isAdmin: () => true,
  });
  await bridge.start();
  adapter.inject(msg({ messageId: "evt-1" }));
  await settle();

  assert.ok(adapter.sent.length >= 4, `expected several chunks, got ${adapter.sent.length}`);
  // The adapter's own cap is honoured — not the bridge's 1900-byte default.
  for (const s of adapter.sent) assert.ok(Buffer.byteLength(s.text) <= 50);
  assert.equal(adapter.sent[0].opts?.replyTo, "evt-1");
  assert.equal(adapter.sent[1].opts?.replyTo, "sent-1", "chunk 2 should hang off chunk 1");
  assert.equal(adapter.sent[2].opts?.replyTo, "sent-2");
  // The whole chain stays in one thread.
  for (const s of adapter.sent) assert.equal(s.opts?.threadRoot, "evt-1");
});

test("a platform without message ids gets plain sends, not threading options", async () => {
  const adapter = makeFakeAdapter();
  const bridge = new MessagingBridge({
    adapter,
    runTurn: async (_c, _t, onText) => {
      onText("answer");
      return { ok: true };
    },
    isAllowed: () => true,
    isAdmin: () => true,
  });
  await bridge.start();
  adapter.inject(msg()); // no messageId — Telegram/Slack/Discord/WhatsApp today
  await settle();
  assert.equal(adapter.sent[0].opts, undefined);
});

// ── attachments ────────────────────────────────────────────────────────────────

test("promptWithAttachments appends a footer the agent can act on", () => {
  assert.equal(promptWithAttachments(msg({ text: "look" })), "look");
  assert.equal(
    promptWithAttachments(
      msg({ text: "look", attachments: [{ mediaType: "image/png", name: "a.png", url: "http://h/x" }] }),
    ),
    "look\n\n[attached: image/png — a.png — http://h/x]",
  );
  // An attachment-only message still produces a usable prompt.
  assert.equal(
    promptWithAttachments(msg({ text: "", attachments: [{ mediaType: "image/png", id: "sha" }] })),
    "[attached: image/png — sha]",
  );
});

test("attachments reach the turn runner", async () => {
  const adapter = makeFakeAdapter();
  let seen = "";
  const bridge = new MessagingBridge({
    adapter,
    runTurn: async (_c, text, onText) => {
      seen = text;
      onText("ok");
      return { ok: true };
    },
    isAllowed: () => true,
    isAdmin: () => true,
  });
  await bridge.start();
  adapter.inject(msg({ text: "what is this", attachments: [{ mediaType: "image/png", url: "http://h/y" }] }));
  await settle();
  assert.ok(seen.includes("[attached: image/png — http://h/y]"), seen);
});

test("audit lines carry the triggering messageId but never other users' mentions", async () => {
  const adapter = makeFakeAdapter();
  const events: any[] = [];
  const bridge = new MessagingBridge({
    adapter,
    runTurn: async (_c, _t, onText) => {
      onText("ok");
      return { ok: true };
    },
    isAllowed: () => true,
    isAdmin: () => true,
    onAudit: (e) => events.push(e),
  });
  await bridge.start();
  adapter.inject(msg({ messageId: "evt-9", mentions: ["someone-elses-pubkey"] }));
  await settle();
  const prompt = events.find((e) => e.event === "prompt");
  assert.equal(prompt.messageId, "evt-9");
  // Third-party ids are PII and must not land in the append-only audit file.
  assert.ok(!JSON.stringify(events).includes("someone-elses-pubkey"));
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
