/**
 * Channel management for the app — the sibling of routinesControl.ts, but for the
 * messaging-channel config (Telegram/Slack/Discord/WhatsApp) rather than scheduled
 * routines.
 *
 * Like routines, this is owned by the ALWAYS-ON daemon relay (daemon/index.ts),
 * NOT the channels daemon (channels/run.ts) — which may be down, and which the app
 * must be able to configure before it has ever run. So this control edits the
 * `channels` block of ~/.privateer/config.json; the channels daemon adopts changes
 * on its next RESTART, matching run.ts's deliberate "no in-chat toggle, restart is
 * the fail-safe reset" posture. `running` is a best-effort read of the channels
 * daemon's heartbeat (channels/status.ts), never a dependency.
 *
 * SECRETS: bot tokens are WRITE-ONLY from the app's perspective. list() NEVER
 * returns a token value — it reports `configured`, `running`, and `secretsSet`
 * (which secret fields are present, by name only). save() persists whatever secret
 * VALUES it is handed in `draft.secrets`; the seal/open of those values in transit
 * is the caller's job (Phase 3), so this module only ever deals in the plaintext
 * config.json it already owns.
 *
 * Framework-agnostic: nothing here imports React or the relay. The caller owns the
 * frame plumbing and the running-presence read.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { configPath } from "../config/paths.ts";

// The platforms channels/run.ts knows how to start. Order is the app's display
// order. Keep in sync with the `startChannel` calls in run.ts.
export const CHANNEL_PLATFORMS = ["telegram", "slack", "discord", "whatsapp"] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

const POSTURES = ["readonly", "approve", "auto"] as const;
export type ChannelPosture = (typeof POSTURES)[number];

// The secret (never-echoed) fields per platform — the union of the token blocks
// run.ts requires to START each platform. `secretsSet` reports presence of these.
const SECRET_FIELDS: Record<ChannelPlatform, string[]> = {
  telegram: ["botToken"],
  slack: ["appToken", "botToken"],
  discord: ["botToken"],
  whatsapp: ["phoneNumberId", "accessToken", "verifyToken", "appSecret"],
};

// Non-secret projection of one platform's config, sent to the app. No token
// values, ever — only which secret fields are already present (`secretsSet`).
export interface RemoteChannel {
  platform: ChannelPlatform;
  configured: boolean; // a config block exists for this platform
  running: boolean; // the channels daemon is currently serving it
  adminCount: number;
  memberCount: number;
  posture: ChannelPosture;
  tools: string[];
  model?: string;
  secretsSet: string[]; // e.g. ["botToken"] — names only, never values
}

// An app-submitted edit. Non-secret fields REPLACE when present; `secrets` maps a
// secret field name → its (already-opened) value, and only present, non-empty
// values overwrite — omitted means "keep the existing value".
export interface ChannelDraft {
  platform: ChannelPlatform;
  admins?: string[];
  members?: string[];
  posture?: ChannelPosture;
  tools?: string[];
  model?: string;
  secrets?: Record<string, string>;
}

export interface ChannelsControl {
  // All four platforms, always — configured or not — so the app can show empty
  // slots to set up. Order follows CHANNEL_PLATFORMS.
  list(): RemoteChannel[];
  // Create or edit a platform's config. Validates posture + fail-closes on a block
  // with no admins/members (mirrors run.ts). Returns a one-line result.
  save(draft: ChannelDraft): { ok: boolean; message?: string };
  // Delete a platform's config entirely. ok:false when nothing was configured.
  remove(platform: ChannelPlatform): { ok: boolean; message?: string };
}

function isPlatform(v: unknown): v is ChannelPlatform {
  return typeof v === "string" && (CHANNEL_PLATFORMS as readonly string[]).includes(v);
}

function normalizePosture(v: unknown): ChannelPosture | undefined {
  return typeof v === "string" && (POSTURES as readonly string[]).includes(v) ? (v as ChannelPosture) : undefined;
}

function cleanStrList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => String(x ?? "").trim()).filter(Boolean);
  return out.length > 0 ? out : [];
}

export function makeChannelsControl(opts: {
  // Which platforms the channels daemon is serving right now (heartbeat read).
  // Absent → everything reports not-running.
  runningPlatforms?: () => Set<string>;
}): ChannelsControl {
  const running = opts.runningPlatforms ?? (() => new Set<string>());

  function readCfg(): any {
    try {
      return JSON.parse(readFileSync(configPath(), "utf8"));
    } catch {
      return {};
    }
  }

  function toRemote(platform: ChannelPlatform, block: any, live: Set<string>): RemoteChannel {
    const admins = block?.admins ?? block?.allowFrom ?? []; // legacy allowFrom == admins
    return {
      platform,
      configured: !!block,
      running: live.has(platform),
      adminCount: Array.isArray(admins) ? admins.length : 0,
      memberCount: Array.isArray(block?.members) ? block.members.length : 0,
      posture: normalizePosture(block?.posture) ?? "approve",
      tools: Array.isArray(block?.tools) ? block.tools.map(String) : [],
      model: typeof block?.model === "string" ? block.model : undefined,
      secretsSet: SECRET_FIELDS[platform].filter((f) => block?.[f]),
    };
  }

  return {
    list(): RemoteChannel[] {
      const ch = readCfg().channels ?? {};
      const live = running();
      return CHANNEL_PLATFORMS.map((p) => toRemote(p, ch[p], live));
    },

    save(draft: ChannelDraft): { ok: boolean; message?: string } {
      if (!isPlatform(draft?.platform)) return { ok: false, message: "Unknown platform." };
      if (draft.posture !== undefined && !normalizePosture(draft.posture))
        return { ok: false, message: "Invalid posture." };

      const cfg = readCfg();
      cfg.channels ??= {};
      const block: any = { ...(cfg.channels[draft.platform] ?? {}) };

      // Non-secret fields replace when provided. An explicit empty array clears.
      const admins = cleanStrList(draft.admins);
      if (admins !== undefined) block.admins = admins;
      const members = cleanStrList(draft.members);
      if (members !== undefined) block.members = members;
      if (draft.posture !== undefined) block.posture = draft.posture;
      const tools = cleanStrList(draft.tools);
      if (tools !== undefined) block.tools = tools;
      if (draft.model !== undefined) {
        const m = String(draft.model).trim();
        if (m) block.model = m;
        else delete block.model;
      }

      // Secrets: a present, non-empty value overwrites; omitted keeps the existing.
      for (const [k, v] of Object.entries(draft.secrets ?? {})) {
        if (!SECRET_FIELDS[draft.platform].includes(k)) continue;
        const val = String(v ?? "").trim();
        if (val) block[k] = val;
      }

      // Fail-closed: never persist a block that can't authorize anyone (mirrors
      // run.ts:261 — a channel with no admins/members is skipped anyway).
      const hasAdmins = Array.isArray(block.admins) && block.admins.length > 0;
      const hasMembers = Array.isArray(block.members) && block.members.length > 0;
      if (!hasAdmins && !hasMembers)
        return { ok: false, message: "Add at least one admin before saving." };

      cfg.channels[draft.platform] = block;
      try {
        writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
      } catch (e) {
        return { ok: false, message: `Couldn't write config: ${e instanceof Error ? e.message : String(e)}` };
      }
      return { ok: true, message: `Saved ${draft.platform}. Restart the channels daemon to apply.` };
    },

    remove(platform: ChannelPlatform): { ok: boolean; message?: string } {
      if (!isPlatform(platform)) return { ok: false, message: "Unknown platform." };
      const cfg = readCfg();
      if (!cfg.channels?.[platform]) return { ok: false, message: "Not configured." };
      delete cfg.channels[platform];
      try {
        writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
      } catch (e) {
        return { ok: false, message: `Couldn't write config: ${e instanceof Error ? e.message : String(e)}` };
      }
      return { ok: true, message: `Removed ${platform}. Restart the channels daemon to apply.` };
    },
  };
}
