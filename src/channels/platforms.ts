// The per-platform facts that BOTH the channels runtime and the app-facing config
// control need to agree on: which platforms exist, which of their fields are
// secrets, how big a single message may be, and whether a given config block has
// enough in it to start.
//
// This file is deliberately the ONLY place those four things are declared. Before
// it existed they were duplicated between the `startChannel` if-chain in run.ts and
// the CHANNEL_PLATFORMS/SECRET_FIELDS constants in remote/channelsControl.ts, with
// a "keep in sync" comment as the only thing holding them together. Adding a
// platform now means editing this file plus wiring one adapter.
//
// Pi-free and dependency-free on purpose: channelsControl.ts runs inside the harbor
// (which must be able to configure a channel that has never run), while the runtime
// runs wherever the bots live. Both import this; neither imports the other.

export const CHANNEL_PLATFORMS = ["telegram", "slack", "discord", "whatsapp"] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

export function isChannelPlatform(v: unknown): v is ChannelPlatform {
  return typeof v === "string" && (CHANNEL_PLATFORMS as readonly string[]).includes(v);
}

// The secret (never-echoed) fields per platform — the union of the credentials each
// platform needs to START. `secretsSet` in the app reports the PRESENCE of these by
// name; their values never cross the wire back to the app.
export const SECRET_FIELDS: Record<ChannelPlatform, readonly string[]> = {
  telegram: ["botToken"],
  slack: ["appToken", "botToken"],
  discord: ["botToken"],
  whatsapp: ["phoneNumberId", "accessToken", "verifyToken", "appSecret"],
};

// Per-message size ceiling, in BYTES of UTF-8 content, sitting just under each
// platform's documented hard cap so a multi-byte reply can't overshoot:
//   telegram 4096 chars · slack ~40k · discord 2000 chars · whatsapp 4096 chars
// The bridge reads the adapter's own `maxMessageBytes` at send time; this table is
// what the adapters (and outbound delivery, which has no adapter instance in hand)
// are configured from.
export const MAX_MESSAGE_BYTES: Record<ChannelPlatform, number> = {
  telegram: 4000,
  slack: 39_000,
  discord: 1900,
  whatsapp: 3900,
};

// Does this config block carry everything the platform needs to start? Mirrors the
// conditions the runtime uses to decide whether to construct an adapter at all.
//
// NOTE this checks CREDENTIALS only. The other fail-closed requirement — at least
// one admin or member — is deliberately NOT here: it's shared across every platform
// and is enforced once, by the runtime and by channelsControl.save().
export function startableFrom(platform: ChannelPlatform, block: any): boolean {
  if (!block) return false;
  switch (platform) {
    case "telegram":
      return !!block.botToken;
    case "slack":
      return !!block.appToken && !!block.botToken;
    case "discord":
      return !!block.botToken;
    case "whatsapp":
      return !!block.phoneNumberId && !!block.accessToken && !!block.verifyToken;
  }
}
