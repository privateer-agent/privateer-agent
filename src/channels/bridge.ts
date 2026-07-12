// The transport-agnostic core of the messaging channels — the analog of
// RemoteBridge for the relay. It owns the policy that must be identical on every
// platform:
//   - allowlist    (who may drive the agent; fail-closed + silent to strangers)
//   - serialization (one turn per conversation at a time; extra messages queue)
//   - redaction     (chat platforms are external egress — scrub before send)
//   - chunking      (respect the platform's per-message length cap)
//
// The agent itself is injected as `runTurn`, so this file stays Pi-free and
// unit-testable against a fake adapter + fake runner (see tests/channels.test.ts).
// The Pi-backed runner lives in ./run.ts.

import type { ChannelAdapter, InboundMessage } from "./types.ts";

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
}

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
  onLog?: (msg: string) => void;
  // Optional append-only security audit sink.
  onAudit?: (event: AuditEvent) => void;
}

// Stay comfortably under Telegram's 4096-char hard cap (Slack ~40k, Discord 2000 —
// pick the tightest common bound for the shared path; a platform with a smaller cap
// can override in its adapter later).
const MAX_MSG = 1900;

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

// Split text into <=max chunks, preferring newline boundaries so code/paragraphs
// aren't cut mid-line when possible.
export function chunkText(text: string, max = MAX_MSG): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max; // no usable newline in the back half → hard cut
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
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

  constructor(private readonly cfg: MessagingBridgeConfig) {}

  async start(): Promise<void> {
    await this.cfg.adapter.start((m) => this.onMessage(m));
    this.log(`channel "${this.cfg.adapter.name}" listening`);
  }

  stop(): void {
    this.cfg.adapter.stop();
    for (const a of this.aborts.values()) a.abort();
    this.aborts.clear();
    // Fail any pending approvals closed so no turn hangs on shutdown.
    for (const resolve of this.approvals.values()) resolve("deny");
    this.approvals.clear();
  }

  // Ask the user in `chatId` to approve a gated tool action, and await their yes/no
  // reply. Wired to the permission gate's remote approver (see channels/run.ts): the
  // gate suspends the tool until this resolves. Fail-closed — timeout, abort (/stop),
  // or shutdown all resolve to "deny". Public because the gate calls it directly
  // (via an AsyncLocalStorage handle to this bridge + the current chat id).
  requestApproval(chatId: string, req: ApprovalRequest, signal?: AbortSignal): Promise<"allow" | "deny"> {
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
    void this.cfg.adapter.sendText(chatId, this.cfg.redact ? this.cfg.redact(prompt) : prompt);

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
        void this.cfg.adapter.sendText(chatId, "🚫 request interrupted — denied.");
        settle("deny");
      };
      timer = setTimeout(() => {
        void this.cfg.adapter.sendText(chatId, "⌛ approval timed out — denied.");
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
    });
  }

  private onMessage(m: InboundMessage): void {
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

    // Serialize per conversation: chain onto this chat's tail.
    const prev = this.tails.get(m.chatId) ?? Promise.resolve();
    const next = prev
      .then(() => this.handle(m))
      .catch((e) => this.log(`turn error: ${e instanceof Error ? e.message : String(e)}`));
    this.tails.set(m.chatId, next);
    // Drop the tail once this was the last queued turn, so the map doesn't grow.
    void next.finally(() => {
      if (this.tails.get(m.chatId) === next) this.tails.delete(m.chatId);
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
      result = await this.cfg.runTurn(chatId, m.text.trim(), (d) => (buf += d), ac.signal, {
        userId: m.userId,
        isAdmin,
      });
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.aborts.delete(chatId);
    }

    const body = this.cfg.redact ? this.cfg.redact(buf) : buf;

    // Deliver any text the turn produced (even on error — a partial answer is
    // useful), then an error line if it failed.
    if (body.trim()) {
      for (const chunk of chunkText(body)) await this.cfg.adapter.sendText(chatId, chunk);
    } else if (result.ok) {
      await this.cfg.adapter.sendText(chatId, "✓ done (no text output).");
    }
    if (!result.ok) {
      await this.cfg.adapter.sendText(chatId, `⚠️ ${result.error ?? "the agent hit an error"}`);
    }
  }
}
