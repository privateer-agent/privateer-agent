// Named terminals: which name means which window, shared by every Privateer on this
// machine. One agent opens "api"; a second agent, or the user's /term in any window,
// can bring "api" to the front. So the record lives in the global dir, not in the
// session.
//
// A record is (app, id) → name. Ids are ttys or tmux pane ids, and both get reused once
// their window is gone, so records are pruned against what the backend says exists
// before they are trusted (see listTerminals) — a stale "api" must not focus whatever
// unrelated window inherited its tty.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalDir } from "../config/paths.ts";
import type { TerminalApp, TerminalBackend } from "./backends.ts";

export interface TerminalRecord {
  name: string;
  app: TerminalApp;
  /** The window's tty (/dev/ttys004) or tmux pane id (%12). */
  id: string;
  /** The folder it was opened in. */
  cwd: string;
  /** What the agent started in it, if anything. */
  command?: string;
  /** Epoch ms. */
  createdAt: number;
}

export function registryPath(): string {
  return join(globalDir(), "terminals.json");
}

export function readRegistry(): TerminalRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(), "utf8"));
    const list = Array.isArray(parsed?.terminals) ? parsed.terminals : [];
    return list.filter(
      (r: any) => r && typeof r.name === "string" && typeof r.id === "string" && typeof r.app === "string",
    );
  } catch {
    return [];
  }
}

function writeRegistry(records: TerminalRecord[]): void {
  const dir = globalDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Rename over the old file so a second Privateer reading at the same moment sees the
  // old list or the new one, never half of each.
  const tmp = `${registryPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ terminals: records }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, registryPath());
}

const MAX_NAME = 40;

/** A usable name, or why not. Names are matched without regard to case. */
export function checkName(raw: string): { name: string } | { error: string } {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return { error: "A terminal needs a name." };
  if (name.length > MAX_NAME) return { error: `Keep terminal names to ${MAX_NAME} characters.` };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name)) {
    return { error: "Terminal names are letters, digits, spaces, dots, dashes and underscores." };
  }
  return { name };
}

export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `base`, or `base-2`, `base-3`… — the first not already taken. */
export function freeName(base: string, taken: readonly TerminalRecord[]): string {
  const used = (n: string) => taken.some((r) => sameName(r.name, n));
  if (!used(base)) return base;
  for (let i = 2; ; i++) if (!used(`${base}-${i}`)) return `${base}-${i}`;
}

/** Records for windows that still exist on this backend. Others' records are kept. */
export async function listTerminals(backend: TerminalBackend): Promise<TerminalRecord[]> {
  const all = readRegistry();
  let live: Set<string>;
  try {
    live = await backend.live();
  } catch {
    return all.filter((r) => r.app === backend.app); // can't check: trust, don't prune
  }
  const kept = all.filter((r) => r.app !== backend.app || live.has(r.id));
  if (kept.length !== all.length) writeRegistry(kept);
  return kept.filter((r) => r.app === backend.app);
}

export function findTerminal(records: readonly TerminalRecord[], name: string): TerminalRecord | undefined {
  return records.find((r) => sameName(r.name, name));
}

/** Add or replace: one record per window, one window per name. */
export function saveTerminal(rec: TerminalRecord): void {
  const others = readRegistry().filter(
    (r) => !(r.app === rec.app && r.id === rec.id) && !(r.app === rec.app && sameName(r.name, rec.name)),
  );
  writeRegistry([...others, rec]);
}

export function forgetTerminal(app: TerminalApp, id: string): void {
  const all = readRegistry();
  const kept = all.filter((r) => !(r.app === app && r.id === id));
  if (kept.length !== all.length) writeRegistry(kept);
}
