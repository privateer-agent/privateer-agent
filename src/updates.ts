// What's out of date — the two kinds of update a Privateer terminal can have pending,
// owned in one place so every surface gives the same answer.
//
//   1. THE CLI ITSELF (privateer-agent). Read from the cache the launcher refreshes in
//      the background at most ~daily (bin/privateer-launch.mjs refreshUpdateCache). We
//      never fetch here, so the banner stays synchronous and offline-safe. Applying it
//      REPLACES the running program, so it can only ever be `privateer update` from a
//      shell — never live.
//   2. TOOL PACKS (Pi "packages": extensions/skills/prompts/themes installed from npm or
//      git). Checked in-process by extensions/privateer-update.ts, held here in memory,
//      and applied live — see that file for why a running terminal can swap them out.
//
// The two consumers are different extensions (the banner draws the pending state, /update
// acts on it), so the pack list gets the same listener idiom as src/context.ts's
// onContextChanged: a setter fires listeners, and neither extension imports the other.
// In memory rather than on disk ON PURPOSE — a cache file outlives the update that
// cleared it, and a banner still flying the flag after you've fetched everything is worse
// than one that shows up a second late.
//
// IMPORT-SAFETY: no Pi imports, no side effects — safe to load from a jiti-loaded
// extension and from pre-boot code alike.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globalDir } from "./config/paths.ts";

// ── the CLI release ──────────────────────────────────────────────────────────

// Is dotted version `a` newer than `b`? Plain numeric compare of major.minor.patch —
// enough for our npm releases; anything unparseable sorts as 0 and is treated as older.
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

/**
 * The newer privateer-agent release the launcher's cache knows about, or null when we're
 * current / offline / never checked. Reads only — the refresh is the launcher's job.
 */
export function pendingCliUpdate(current: string): string | null {
  try {
    const { latest } = JSON.parse(readFileSync(join(globalDir(), "update-check.json"), "utf8"));
    if (typeof latest === "string" && isNewer(latest, current)) return latest;
  } catch {
    // no cache yet, unreadable, or malformed — nothing pending as far as we know.
  }
  return null;
}

// ── tool packs ───────────────────────────────────────────────────────────────

/** One installed pack with a newer version available. Mirrors Pi's PackageUpdate. */
export interface PackUpdate {
  /** The configured source string ("pi-hermes-memory", "github:owner/repo", …). */
  source: string;
  /** What to show a human — Pi's own label for the pack. */
  displayName: string;
  type: "npm" | "git";
  scope: "user" | "project";
}

type Listener = () => void;

// ⚠️ MODULE STATE IS NOT SHARED BETWEEN EXTENSIONS. Pi loads every extension through its
// OWN jiti instance with moduleCache:false (core/extensions/loader.js), so a module two
// extensions both import is instantiated TWICE — a plain module-level `let` here would
// leave the banner reading a different copy from the one /update writes, and the flag
// would never appear. Verified rather than assumed: two jiti instances importing the same
// relative module see completely independent state, and a globalThis-keyed store is what
// crosses between them. Symbol.for so both copies resolve the same key.
const STATE = Symbol.for("privateer.updates.packs");
interface PackState {
  pending: readonly PackUpdate[];
  listeners: Set<Listener>;
}
const state: PackState = (((globalThis as any)[STATE] ??= {
  pending: [],
  listeners: new Set<Listener>(),
}) as PackState);

/** Packs with an update waiting, as of the last check. Empty until the check lands. */
export function pendingPackUpdates(): readonly PackUpdate[] {
  return state.pending;
}

/** Record the result of a check (or of an update that cleared the list) and notify. */
export function setPendingPackUpdates(next: readonly PackUpdate[]): void {
  state.pending = [...next];
  for (const fn of state.listeners) {
    try {
      fn();
    } catch {
      // a broken listener must not break the check that called us.
    }
  }
}

/** Called whenever the pending list changes — the banner re-renders from it. */
export function onPackUpdatesChanged(fn: Listener): void {
  state.listeners.add(fn);
}
