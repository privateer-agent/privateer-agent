// Messaging-channel plumbing — the inbound/conversational counterpart to the relay.
//
// The relay (src/remote/*) lets the Privateer app drive this terminal. A messaging
// channel (Telegram/Slack/Discord/Buzz) is the SAME idea with a different transport:
// a user's message becomes a prompt, the agent's reply goes back to the channel.
// `ChannelAdapter` is the one platform-specific seam; everything above it (allowlist,
// mention gating, per-chat serialization, redaction, chunking) lives in
// MessagingBridge and is shared across every platform.
//
// EVERY field beyond the original four is OPTIONAL, and that is a load-bearing
// design choice rather than politeness: an adapter that cannot thread, cannot see
// mentions, or carries no message ids simply omits them, and the bridge reads
// "absent" as "this platform doesn't support it". That is what lets a rich platform
// (Buzz: message ids, NIP-10 threads, relay-indexed mentions, Blossom attachments)
// share one contract with a plain one, with no per-adapter branching in the bridge.

/** A file or image referenced by an inbound message. */
export interface Attachment {
  /** The platform's content id — Buzz: the Blossom sha256. */
  id?: string;
  /** Fetchable by this machine. May require adapter-supplied auth. */
  url?: string;
  mediaType?: string;
  name?: string;
  bytes?: number;
}

// A normalized inbound message from any platform. `chatId` scopes the conversation
// (so each thread keeps its own agent session); `userId` is who sent it (allowlist
// key). Both are strings so platform-native numeric ids don't leak type differences
// upward.
export interface InboundMessage {
  chatId: string;
  userId: string;
  userName?: string;
  text: string;

  /** This message's own platform id — Buzz: the nostr event id. Needed to reply
   *  in-thread or react to it. */
  messageId?: string;
  /** The message this one directly answers — Buzz: NIP-10 "e" tag marked "reply". */
  replyToId?: string;
  /** The root of the thread this belongs to — Buzz: "e" marked "root". Equal to
   *  `replyToId` at depth one. */
  threadRootId?: string;
  /** Everyone this message @-mentions, in platform-native id form. */
  mentions?: string[];
  /** Does it mention THIS agent? Only the adapter knows its own identity on the
   *  platform, so the adapter reports the FACT — the bridge owns the POLICY of what
   *  to do about it (see `mentionGate`). */
  mentionsMe?: boolean;
  /** True when this is a 1:1 conversation rather than a shared room — Buzz: a
   *  channel of type "Dm". A DM is inherently addressed to the agent, so the
   *  mention gate can let it through without an explicit @. */
  isDirect?: boolean;
  attachments?: Attachment[];
}

/** How an outbound message relates to the conversation. An adapter that can't
 *  thread ignores this entirely — passing it is always safe. */
export interface SendOptions {
  replyTo?: string;
  threadRoot?: string;
}

export interface OutboundMedia {
  bytes: Uint8Array;
  mediaType: string;
  name?: string;
  caption?: string;
}

// The per-platform transport. Implementations own the connection (long-poll,
// gateway socket, relay websocket, or inbound webhook) and the wire format; they
// surface normalized messages and accept plain text back. Keep them DUMB: no
// allowlist, no redaction, no chunking, no gating — the bridge does all of that so
// it's written once and tested once.
export interface ChannelAdapter {
  readonly name: string;
  /** This agent's own id on the platform — Buzz: its pubkey hex. Used to recognize
   *  self-authored events and to resolve `mentionsMe`. Absent when the platform has
   *  no stable identity for the bot. */
  readonly selfId?: string;
  /** Per-message ceiling in BYTES of UTF-8 content. The bridge chunks to this;
   *  absent falls back to a conservative shared default. Before this existed the
   *  bridge hardcoded Discord's limit for every platform. */
  readonly maxMessageBytes?: number;

  // Begin receiving. Call `onMessage` for every inbound user message.
  start(onMessage: (m: InboundMessage) => void): Promise<void>;
  /** Send a reply. The bridge guarantees `text` is already redacted and within
   *  `maxMessageBytes`. Returns the sent message's platform id when the adapter
   *  knows it, so the bridge can chain later chunks beneath it — returning nothing
   *  is fine and simply means later chunks hang off the same parent. */
  sendText(chatId: string, text: string, opts?: SendOptions): Promise<string | void>;
  // Optional "the agent is working" affordance (typing indicator). Best-effort.
  sendTyping?(chatId: string): void;
  /** React to a message — Buzz: NIP-25 kind 7. Best-effort; never awaited on a
   *  path that must not fail. */
  sendReaction?(chatId: string, messageId: string, emoji: string): Promise<void>;
  sendMedia?(chatId: string, media: OutboundMedia, opts?: SendOptions): Promise<void>;
  // Stop receiving and release the connection. May be async: an adapter that owns a
  // LISTENING SOCKET (whatsapp) has to await the port actually being free, or the
  // next start() races its own teardown and fails with EADDRINUSE. Callers must
  // await this before restarting the same platform.
  stop(): void | Promise<void>;
}
