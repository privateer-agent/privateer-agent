// Messaging-channel plumbing — the inbound/conversational counterpart to the relay.
//
// The relay (src/remote/*) lets the Privateer app drive this terminal. A messaging
// channel (Telegram/Slack/Discord/WhatsApp) is the SAME idea with a different
// transport: a user's message becomes a prompt, the agent's reply goes back to the
// channel. `ChannelAdapter` is the one platform-specific seam; everything above it
// (allowlist, per-chat serialization, redaction, chunking) lives in MessagingBridge
// and is shared across every platform.

// A normalized inbound message from any platform. `chatId` scopes the conversation
// (so each thread keeps its own agent session); `userId` is who sent it (allowlist
// key). Both are strings so platform-native numeric ids don't leak type differences
// upward.
export interface InboundMessage {
  chatId: string;
  userId: string;
  userName?: string;
  text: string;
}

// The per-platform transport. Implementations own the connection (long-poll,
// gateway socket, or inbound webhook) and the wire format; they surface normalized
// messages and accept plain text back. Keep them DUMB: no allowlist, no redaction,
// no chunking — the bridge does all of that so it's written once and tested once.
export interface ChannelAdapter {
  readonly name: string;
  // Begin receiving. Call `onMessage` for every inbound user message.
  start(onMessage: (m: InboundMessage) => void): Promise<void>;
  // Send a reply to a conversation. The bridge guarantees `text` is already
  // redacted and within the platform's per-message length cap.
  sendText(chatId: string, text: string): Promise<void>;
  // Optional "the agent is working" affordance (typing indicator). Best-effort.
  sendTyping?(chatId: string): void;
  // Stop receiving and release the connection.
  stop(): void;
}
