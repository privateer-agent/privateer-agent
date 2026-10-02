/**
 * Which image and video models this machine's agent generates with, when the agent
 * doesn't name one itself. Set by `/image-model` and `/video-model`
 * (extensions/privateer-media.ts), stored as `media.imageModel` / `media.videoModel`
 * in ~/.privateer/config.json.
 *
 * PER MACHINE, NOT PER ACCOUNT. The account already has a default for each (the app's
 * own picker writes it, server-side), and that is what an unset value here falls through
 * to. A terminal choice deliberately does not write back to it: picking a cheap video
 * model for a batch of terminal drafts should not change what the phone renders with.
 *
 * PRECEDENCE, highest first: the tool call's own `model` → this file → the account
 * default. The agent naming a model still wins, because it only does that when a job
 * calls for a specific one (a 4K clip, a model that takes a last frame).
 *
 * Read at CALL time, like piiAllow.ts: a pick made in one terminal reaches a harbor or
 * a second terminal on the same machine on its next generation, without a restart.
 * Missing file, unreadable file and malformed JSON all mean "no choice" — the account
 * default — never a crash in the middle of a tool call.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./paths.ts";
import { writeFileAtomic } from "../util/atomicWrite.ts";

export type MediaKind = "image" | "video";

const KEY: Record<MediaKind, "imageModel" | "videoModel"> = { image: "imageModel", video: "videoModel" };

function readConfig(): Record<string, unknown> {
  try {
    const cfg = JSON.parse(readFileSync(configPath(), "utf8"));
    return cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
  } catch {
    return {};
  }
}

/** The chosen model id for `kind`, or undefined to use the account default. */
export function mediaModelPref(kind: MediaKind): string | undefined {
  const media = readConfig().media as Record<string, unknown> | undefined;
  const v = media?.[KEY[kind]];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Set (or, with null, clear) the choice for `kind`. Every other key in config.json is
 * preserved — it also holds webhooks, privacy and coauthor settings this must not drop.
 */
export function setMediaModelPref(kind: MediaKind, id: string | null): void {
  const cfg = readConfig();
  const media = { ...((cfg.media as Record<string, unknown>) ?? {}) };
  const clean = id?.trim();
  if (clean) media[KEY[kind]] = clean;
  else delete media[KEY[kind]];
  const next: Record<string, unknown> = { ...cfg, media };
  if (Object.keys(media).length === 0) delete next.media;
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileAtomic(configPath(), JSON.stringify(next, null, 2) + "\n");
}

/** The model a call should send: its own `model`, else this machine's choice, else none. */
export function effectiveMediaModel(kind: MediaKind, requested: unknown): string | undefined {
  return typeof requested === "string" && requested.trim() ? requested.trim() : mediaModelPref(kind);
}
