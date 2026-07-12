// Channels daemon heartbeat — the one bit of shared state between the channels
// daemon (channels/run.ts, the WRITER) and the always-on management relay
// (daemon/index.ts → channelsControl, the READER).
//
// The two run as SEPARATE processes, so the manager can't ask the channels
// daemon directly whether it's live. Instead the channels daemon writes a small
// heartbeat file with the platforms it's currently serving; the reader treats a
// FRESH heartbeat as "running" and a stale/absent one as "not running". This is
// best-effort presence, never a dependency: a missing file just means the app
// shows the platform as configured-but-offline.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalDir } from "../config/paths.ts";

// Heartbeat cadence + freshness window. The channels daemon rewrites the file
// every HEARTBEAT_MS; a heartbeat older than STALE_MS is treated as dead (the
// process exited without clearing it, or wedged).
export const HEARTBEAT_MS = 30_000;
const STALE_MS = 90_000; // 3 missed beats

interface ChannelsStatus {
  pid: number;
  at: string; // ISO timestamp of the last heartbeat
  platforms: string[]; // platforms with a live bridge this beat
}

function statusPath(): string {
  return join(globalDir(), "channels-status.json");
}

// WRITER: record which platforms have a live bridge right now. Called on start
// and on each heartbeat tick. Best-effort — a failed write never breaks a turn.
export function writeChannelsStatus(platforms: string[]): void {
  try {
    const status: ChannelsStatus = { pid: process.pid, at: new Date().toISOString(), platforms };
    writeFileSync(statusPath(), JSON.stringify(status));
  } catch {
    /* best effort */
  }
}

// READER: the set of platforms the channels daemon is currently serving, or an
// empty set when the daemon is down / the heartbeat is stale. Never throws.
export function readRunningPlatforms(): Set<string> {
  try {
    const status = JSON.parse(readFileSync(statusPath(), "utf8")) as ChannelsStatus;
    const age = Date.now() - Date.parse(status.at);
    if (!Number.isFinite(age) || age > STALE_MS) return new Set();
    return new Set(Array.isArray(status.platforms) ? status.platforms.map(String) : []);
  } catch {
    return new Set();
  }
}
