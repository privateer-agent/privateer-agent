// The transport-agnostic core of the messaging channels — the analog of
// RemoteBridge for the relay. It owns the policy that must be identical on every
// platform:
//   - allowlist    (who may drive the agent; fail-closed + silent to strangers)
//   - mention gate  (in a shared room, only act when addressed)
//   - serialization (one turn per conversation at a time; extra messages queue)
//   - redaction     (chat platforms are external egress — scrub before send)
//   - chunking      (respect the platform's per-message byte cap)
//
// ⚠️ SECURITY — DO NOT RESOLVE QUOTED PARENTS. An inbound message may carry a
// `replyToId`, and it is tempting to fetch that parent and inline its text into the
// prompt for context. Don't. The allowlist gates the SENDER, not the room: on a
// shared platform (Buzz channels, a Discord guild, a Slack channel) anyone can post,
// and resolving quoted parents would let a non-allowlisted participant inject
// arbitrary text into the agent's context simply by getting an admin to reply to
// them. Threading ids are for ADDRESSING replies outward, never for pulling content
// inward.
//
// The agent itself is injected as `runTurn`, so this file stays Pi-free and
// unit-testable against a fake adapter + fake runner (see tests/channels.test.ts).
// The Pi-backed runner lives in ./run.ts.

import type { ChannelAdapter, InboundMessage, SendOptions } from "./types.ts";

// A minimal view of the permission request the gate hands us (see
// src/permissions/gate.ts PermissionRequest). Kept local so the bridge doesn't
// depend on the gate module.
export interface ApprovalRequest {
  kind: string;
  title: string;
  detail: string;
}

// Run one agent turn for a conversation. `onText` receives streamed text deltas as
// they arrive; the bridge buffers/coalesces them. Resolves when the turn is done.
// `signal` aborts a queued/in-flight turn (e.g. the user sent "/stop").
export type TurnRunner = (
  chatId: string,
  text: string,
  onText: (delta: string) => void,
  signal: AbortSignal,
  // The triggering user + their role, so the runner (and the gate it drives) can
  // cap a member to read-only regardless of the channel's posture.
  meta: TurnMeta,
) => Promise<{ ok: boolean; error?: string }>;

export interface TurnMeta {
  userId: string;
  isAdmin: boolean;
}

// A security-audit event. The bridge emits these at authorization-relevant moments;
// run.ts appends them to an on-disk log. `detail` is redacted before it's emitted.
export interface AuditEvent {
  at: string;
  event: "prompt" | "approval_request" | "approval_decision" | "interrupt" | "denied";
  chatId: string;
  userId?: string;
  role?: "admin" | "member";
  detail?: string;
  /** The platform id of the triggering message, when the platform has one — makes an
   *  audit line traceable back to the exact message in the channel. Note we
   *  deliberately do NOT log `mentions`: other participants' ids are third-party PII
   *  and don't belong in an append-only file. */
  messageId?: string;
}

/** Whether the agent answers everything in a conversation, or only when addressed.
 *   off           — every allowlisted message runs a turn (the original behavior)
 *   mention       — only when the message @-mentions this agent
 *   mention-or-dm — as above, plus any 1:1 conversation */
export type MentionGate = "off" | "mention" | "mention-or-dm";

export interface MessagingBridgeConfig {
  adapter: ChannelAdapter;
  runTurn: TurnRunner;
  // Who may interact at all (admin OR member). False → ignored (fail-closed and
  // SILENT: we don't confirm the bot exists to un-allowlisted senders).
  isAllowed: (msg: InboundMessage) => boolean;
  // Is this user an admin? Admins are governed by the channel posture and are the
  // ONLY users whose yes/no resolves an approval. Members are read-only and can't
  // approve.
  isAdmin: (msg: InboundMessage) => boolean;
  // Scrub secrets from every outbound message. Wired to redactText in ./run.ts.
  redact?: (text: string) => string;
  // Should the agent answer everything, or only when addressed? Defaults to "off",
  // preserving the original behavior for every existing platform.
  mentionGate?: MentionGate;
  onLog?: (msg: string) => void;
  // Optional append-only security audit sink.
  onAudit?: (event: AuditEvent) => void;
}

// Fallback per-message ceiling in BYTES, used only when an adapter doesn't declare
// its own `maxMessageBytes`. It is the tightest common bound (Discord's 2000-char
// cap, with headroom), so it is safe everywhere and generous nowhere — adapters
// should declare the real figure. See channels/platforms.ts for the per-platform table.
const DEFAULT_MAX_BYTES = 1900;

// How long to wait for a yes/no approval reply before failing closed (deny).
const APPROVAL_TIMEOUT_MS = 120_000;

const YES = new Set(["yes", "y", "allow", "ok", "okay", "approve", "approved", "👍", "✅"]);
const NO = new Set(["no", "n", "deny", "denied", "stop", "cancel", "reject", "👎", "❌"]);

// Interpret an approval reply. Returns null for anything that isn't a clear
// yes/no, so the bridge can re-prompt instead of guessing (fail-safe: never treat
// ambiguous text as allow).
export function approvalDecision(text: string): "allow" | "deny" | null {
  const t = text.trim().toLowerCase();
  if (YES.has(t)) return "allow";
  if (NO.has(t)) return "deny";
  return null;
}

// The message a user sees when the agent wants to run a gated action.
export function approvalPrompt(req: ApprovalRequest): string {
  const detail = req.detail.length > 600 ? req.detail.slice(0, 600) + "\n…(truncated)" : req.detail;
  return `⚠️ Approval needed — ${req.title} (${req.kind})\n\n${detail}\n\nReply "yes" to allow or "no" to deny (times out in 2 min).`;
}

// The longest prefix of `s` that fits in `maxBytes` of UTF-8, cut only on code-point
// boundaries. Iterating the string yields whole code points, so a surrogate pair is
// never split down the middle into two replacement characters.
function sliceByBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s) <= maxBytes) return s;
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > maxBytes) break;
    bytes += b;
    out += ch;
  }
  return out;
}

// Split text into chunks that each fit in `maxBytes`, preferring newline boundaries
// so code/paragraphs aren't cut mid-line when possible.
//
// The cap is in BYTES, not characters, because every platform's limit ultimately is:
// a reply of emoji or CJK is up to 4x longer on the wire than its `.length` suggests,
// and measuring in characters silently overshoots and gets the message rejected.
export function chunkText(text: string, maxBytes = DEFAULT_MAX_BYTES): string[] {
  const out: string[] = [];
  let rest = text;
  while (Buffer.byteLength(rest) > maxBytes) {
    let head = sliceByBytes(rest, maxBytes);
    // A single code point wider than the cap would otherwise loop forever.
    if (!head) head = [...rest][0] ?? "";
    if (!head) break;
    const nl = head.lastIndexOf("\n");
    if (nl > 0 && nl >= head.length * 0.5) head = head.slice(0, nl); // usable newline in the back half
    out.push(head);
    rest = rest.slice(head.length).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Should this message run a turn at all?
 *
 * In a 1:1 chat "answer everything" is right. In a shared room with other humans it
 * is unusable noise — and worse, it means every passing remark becomes a prompt. So
 * a channel can require being addressed.
 *
 * Fails CLOSED on adapters that can't report mentions: if the gate is on and
 * `mentionsMe` is absent, the agent stays quiet rather than answering everything.
 * Enabling a gate a platform can't honour should silence the bot, not defeat the gate.
 */
export function passesMentionGate(m: InboundMessage, mode: MentionGate | undefined): boolean {
  if (!mode || mode === "off") return true;
  if (m.mentionsMe) return true;
  return mode === "mention-or-dm" && m.isDirect === true;
}

/**
 * Render attachments into the prompt text.
 *
 * v1 is a text footer: `TurnRunner` carries only a string, so real multimodal means
 * widening that signature and routing bytes through src/util/attachmentStore.ts.
 * This is the seam where that would go. Deliberately out of scope for now — the URL
 * is enough for an agent with web/read tools to act on.
 */
export function promptWithAttachments(m: InboundMessage): string {
  const text = m.text.trim();
  if (!m.attachments?.length) return text;
  const lines = m.attachments.map((a) => {
    const bits = [a.mediaType ?? "file", a.name, a.url ?? a.id].filter(Boolean);
    return `[attached: ${bits.join(" — ")}]`;
  });
  return text ? `${text}\n\n${lines.join("\n")}` : lines.join("\n");
}

export class MessagingBridge {
  // Per-chat promise tail: each new turn chains onto the previous so turns in the
  // same conversation never interleave (they share one agent session downstream).
  private readonly tails = new Map<string, Promise<void>>();
  // Per-chat abort handle for the in-flight turn, so "/stop" can interrupt it.
  private readonly aborts = new Map<string, AbortController>();
  // Per-chat pending tool approval awaiting a yes/no reply. At most one at a time
  // per chat (turns are serialized and a turn's tool calls are sequential).
  private readonly approvals = new Map<string, (decision: "allow" | "deny") => void>();
  // Where to attach outbound messages in each chat, so replies, approval prompts and
  // error lines all land in the thread that triggered them rather than at the bottom
  // of the room. Empty for platforms without threading — `sendReply` then degrades to
  // a plain send.
  private readonly lastInbound = new Map<string, { messageId?: string; threadRootId?: string }>();
  // Set by stop(). Aborting a turn signals the GATE, not Pi's session.prompt() — so
  // an in-flight turn can still resolve after teardown and try to send its answer
  // through a closed adapter. Every send path checks this first.
  private stopped = false;

  constructor(private readonly cfg: MessagingBridgeConfig) {}

  async start(): Promise<void> {
    await this.cfg.adapter.start((m) => this.onMessage(m));
    this.log(`channel "${this.cfg.adapter.name}" listening`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const a of this.aborts.values()) a.abort();
    this.aborts.clear();
    // Fail any pending approvals closed so no turn hangs on shutdown.
    for (const resolve of this.approvals.values()) resolve("deny");
    this.approvals.clear();
    // Last: an adapter owning a listening socket resolves only once the port is
    // genuinely free, which a targeted platform restart depends on.
    await this.cfg.adapter.stop();
  }

  // Ask the user in `chatId` to approve a gated tool action, and await their yes/no
  // reply. Wired to the permission gate's remote approver (see channels/run.ts): the
  // gate suspends the tool until this resolves. Fail-closed — timeout, abort (/stop),
  // or shutdown all resolve to "deny". Public because the gate calls it directly
  // (via an AsyncLocalStorage handle to this bridge + the current chat id).
  requestApproval(chatId: string, req: ApprovalRequest, signal?: AbortSignal): Promise<"allow" | "deny"> {
    // Torn down: nobody is listening for the reply, so fail closed immediately rather
    // than prompting into a dead channel and waiting out the 2-minute timeout.
    if (this.stopped) return Promise.resolve("deny");
    // Only one outstanding approval per chat; deny any stale one first.
    this.approvals.get(chatId)?.("deny");

    const prompt = approvalPrompt(req);
    const detail = `${req.title}: ${req.detail}`;
    this.cfg.onAudit?.({
      at: new Date().toISOString(),
      event: "approval_request",
      chatId,
      role: "admin", // approvals only arise from admin turns (members are read-only)
      detail: this.cfg.redact ? this.cfg.redact(detail) : detail,
    });
    // Threaded alongside the turn that raised it, so a busy room doesn't scatter the
    // question away from the request that prompted it.
    const opts = this.sendOptions(chatId);
    void this.cfg.adapter.sendText(chatId, this.cfg.redact ? this.cfg.redact(prompt) : prompt, opts);

    return new Promise<"allow" | "deny">((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const settle = (decision: "allow" | "deny") => {
        if (this.approvals.get(chatId) !== settle) return; // already settled
        this.approvals.delete(chatId);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(decision);
      };
      const onAbort = () => {
        void this.cfg.adapter.sendText(chatId, "🚫 request interrupted — denied.", opts);
        settle("deny");
      };
      timer = setTimeout(() => {
        void this.cfg.adapter.sendText(chatId, "⌛ approval timed out — denied.", opts);
        settle("deny");
      }, APPROVAL_TIMEOUT_MS);
      this.approvals.set(chatId, settle);
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  private log(msg: string): void {
    this.cfg.onLog?.(msg);
  }

  // Where an outbound message for this chat should attach. Undefined on platforms
  // that don't carry message ids, which every adapter accepts as "just send it".
  private sendOptions(chatId: string): SendOptions | undefined {
    const last = this.lastInbound.get(chatId);
    if (!last?.messageId) return undefined;
    return { replyTo: last.messageId, threadRoot: last.threadRootId ?? last.messageId };
  }

  private audit(m: InboundMessage, event: AuditEvent["event"], detail?: string): void {
    if (!this.cfg.onAudit) return;
    const red = detail && this.cfg.redact ? this.cfg.redact(detail) : detail;
    this.cfg.onAudit({
      at: new Date().toISOString(),
      event,
      chatId: m.chatId,
      userId: m.userId,
      role: this.cfg.isAdmin(m) ? "admin" : "member",
      detail: red,
      messageId: m.messageId,
    });
  }

  private onMessage(m: InboundMessage): void {
    if (this.stopped) return; // torn down; an adapter may still flush a queued frame
    const text = m.text?.trim();
    if (!text) return;

    if (!this.cfg.isAllowed(m)) {
      // Fail closed and stay silent — replying would confirm the bot to strangers.
      this.log(`ignored message from unauthorized user ${m.userId} in chat ${m.chatId}`);
      return;
    }

    // A pending tool approval in this chat consumes the next message as its answer —
    // BEFORE the per-chat queue, because the turn awaiting approval is itself holding
    // that queue open (routing the reply through the queue would deadlock it).
    const pending = this.approvals.get(m.chatId);
    if (pending) {
      // Only admins may answer an approval. A member's reply is refused (and audited)
      // — never silently treated as a decision.
      if (!this.cfg.isAdmin(m)) {
        this.audit(m, "denied", "non-admin attempted to answer an approval");
        void this.cfg.adapter.sendText(m.chatId, "Only an admin can approve the pending action.");
        return;
      }
      if (text === "/stop") {
        this.audit(m, "approval_decision", "deny (/stop)");
        pending("deny"); // interrupt while awaiting approval → deny it
        return;
      }
      const decision = approvalDecision(text);
      if (decision === null) {
        void this.cfg.adapter.sendText(m.chatId, 'Reply "yes" to allow or "no" to deny the pending action.');
        return;
      }
      this.audit(m, "approval_decision", decision);
      pending(decision);
      return;
    }

    // "/stop" interrupts the running turn instead of queueing another.
    if (text === "/stop") {
      this.aborts.get(m.chatId)?.abort();
      return;
    }

    // The mention gate sits HERE and the position is load-bearing. It must come
    // after the approval interception and after "/stop", because neither of those
    // carries an @mention: gating an approval reply would leave the waiting turn
    // hanging until its 2-minute fail-closed timeout, and gating "/stop" would make
    // the channel uninterruptible.
    if (!passesMentionGate(m, this.cfg.mentionGate)) return;

    // Remember where to attach the reply. Recorded only for messages that actually
    // run a turn, so an approval answer can't retarget the thread mid-conversation.
    this.lastInbound.set(m.chatId, { messageId: m.messageId, threadRootId: m.threadRootId });

    // Serialize per conversation: chain onto this chat's tail.
    const prev = this.tails.get(m.chatId) ?? Promise.resolve();
    const next = prev
      .then(() => this.handle(m))
      .catch((e) => this.log(`turn error: ${e instanceof Error ? e.message : String(e)}`));
    this.tails.set(m.chatId, next);
    // Drop the tail once this was the last queued turn, so the map doesn't grow.
    void next.finally(() => {
      if (this.tails.get(m.chatId) === next) {
        this.tails.delete(m.chatId);
        this.lastInbound.delete(m.chatId); // the reply is out; nothing left to attach to
      }
    });
  }

  private async handle(m: InboundMessage): Promise<void> {
    const { chatId } = m;
    const isAdmin = this.cfg.isAdmin(m);
    this.audit(m, "prompt", m.text.trim().slice(0, 200));
    const ac = new AbortController();
    this.aborts.set(chatId, ac);
    this.cfg.adapter.sendTyping?.(chatId);

    // Buffer the whole turn's text, then send once (coalesced) — the simplest
    // correct choice. Streaming partial edits back to the channel is a future
    // enhancement; buffering avoids a race between deltas and async sends and
    // keeps this unit-testable without timers.
    let buf = "";
    let result: { ok: boolean; error?: string };
    try {
      result = await this.cfg.runTurn(chatId, promptWithAttachments(m), (d) => (buf += d), ac.signal, {
        userId: m.userId,
        isAdmin,
      });
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.aborts.delete(chatId);
    }

    const body = this.cfg.redact ? this.cfg.redact(buf) : buf;

    // The turn may have outlived stop() (aborting reaches the gate, not Pi). Drop the
    // answer rather than pushing it through a closed adapter — on a targeted restart
    // the replacement bridge is already serving this chat.
    if (this.stopped) {
      this.log(`dropped a reply for chat ${chatId} — the channel was stopped mid-turn`);
      return;
    }

    // Send in the thread the request came from, chaining each chunk beneath the
    // previous one when the adapter tells us the id it just wrote — so a long,
    // multi-chunk answer reads as one conversation rather than N siblings.
    const opts = this.sendOptions(chatId);
    const root = opts?.threadRoot;
    let parent = opts?.replyTo;
    const send = async (t: string) => {
      const id = await this.cfg.adapter.sendText(chatId, t, parent ? { replyTo: parent, threadRoot: root } : undefined);
      if (typeof id === "string" && id) parent = id;
    };

    // Deliver any text the turn produced (even on error — a partial answer is
    // useful), then an error line if it failed.
    if (body.trim()) {
      const maxBytes = this.cfg.adapter.maxMessageBytes ?? DEFAULT_MAX_BYTES;
      for (const chunk of chunkText(body, maxBytes)) await send(chunk);
    } else if (result.ok) {
      await send("✓ done (no text output).");
    }
    if (!result.ok) {
      await send(`⚠️ ${result.error ?? "the agent hit an error"}`);
    }
  }
}
