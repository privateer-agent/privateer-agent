// NIP-10 threading and NIP-27 mention helpers — reading meaning out of an event's
// positional tag arrays, and building the tags for a reply.
//
// Pure and adapter-agnostic: the Buzz adapter uses these, but nothing here is
// Buzz-specific.

import type { Tag } from "./event.ts";

/**
 * Extract a reply's thread position from its "e" tags.
 *
 * Two encodings exist in the wild and both must be handled:
 *   MARKERED (current)  ["e", <id>, <relay>, "root"] / [… "reply"]
 *   POSITIONAL (legacy) the FIRST "e" tag is the root, the LAST is the direct
 *                       parent; with exactly one, it is both.
 * A markered tag anywhere wins — mixing the two is malformed, and trusting the
 * explicit marker is the safer read.
 */
export function threadRefs(tags: Tag[]): { root?: string; reply?: string } {
  const eTags = tags.filter((t) => t[0] === "e" && typeof t[1] === "string" && t[1].length > 0);
  if (eTags.length === 0) return {};

  const markered = eTags.filter((t) => t[3] === "root" || t[3] === "reply");
  if (markered.length > 0) {
    return {
      root: markered.find((t) => t[3] === "root")?.[1],
      reply: markered.find((t) => t[3] === "reply")?.[1],
    };
  }

  // Legacy positional form.
  if (eTags.length === 1) return { root: eTags[0][1], reply: eTags[0][1] };
  return { root: eTags[0][1], reply: eTags[eTags.length - 1][1] };
}

/** Every pubkey this event tags — i.e. everyone it @-mentions. */
export function pTags(tags: Tag[]): string[] {
  return tags.filter((t) => t[0] === "p" && typeof t[1] === "string" && t[1].length > 0).map((t) => t[1]);
}

/** Blossom content hashes attached to this event (["x", <sha256>]). */
export function xTags(tags: Tag[]): string[] {
  return tags.filter((t) => t[0] === "x" && typeof t[1] === "string" && t[1].length > 0).map((t) => t[1]);
}

/**
 * Build the tags for a reply.
 *
 * `root` is the thread root and `parent` the message being answered; when only one
 * is known, pass it as both — a reply that marks a root but no parent reads as a
 * top-level post to most clients. Mentioned pubkeys are deduped, since duplicate "p"
 * tags inflate relay-side mention indexes for no benefit.
 */
export function replyTags(root?: string, parent?: string, mentionPubkeys: string[] = []): Tag[] {
  const out: Tag[] = [];
  if (root) out.push(["e", root, "", "root"]);
  if (parent && parent !== root) out.push(["e", parent, "", "reply"]);
  for (const pk of [...new Set(mentionPubkeys)]) out.push(["p", pk]);
  return out;
}
