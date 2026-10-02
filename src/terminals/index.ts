// Named terminals: what the `terminal` tool and /term both do, so the agent and the
// person at the keyboard share one vocabulary — "open api", "go to api", "close api".
//
// The window a Privateer runs in names itself on first use (see claimSelf): its folder's
// name, or the name the agent gave it when it opened it. That is what makes "go back to
// main" possible from a window the agent opened, and what lets the user hop between
// windows they opened by hand once a session in each has started.

import { basename } from "node:path";
import { detectBackend, type TerminalBackend } from "./backends.ts";
import {
  checkName,
  findTerminal,
  forgetTerminal,
  freeName,
  listTerminals,
  saveTerminal,
  type TerminalRecord,
} from "./registry.ts";

export type Outcome = { ok: true; message: string } | { ok: false; message: string };

const fail = (message: string): Outcome => ({ ok: false, message });
const done = (message: string): Outcome => ({ ok: true, message });

let cachedBackend: TerminalBackend | { unsupported: string } | undefined;
/** Fixed for the life of the process: the window we were started in doesn't change. */
export function backend(): TerminalBackend | { unsupported: string } {
  return (cachedBackend ??= detectBackend());
}
/** Tests only. */
export function setBackendForTests(b: TerminalBackend | { unsupported: string } | undefined): void {
  cachedBackend = b;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * This process's own window, registered if it isn't yet. A window the agent opened
 * already has a record under its tty, so a Privateer started there keeps that name.
 */
export async function claimSelf(b: TerminalBackend, cwd: string): Promise<TerminalRecord | undefined> {
  const id = await b.selfId();
  if (!id) return undefined;
  const records = await listTerminals(b);
  const mine = records.find((r) => r.id === id);
  if (mine) return mine;
  const base = checkName(basename(cwd));
  const rec: TerminalRecord = {
    name: freeName("name" in base ? base.name : "main", records),
    app: b.app,
    id,
    cwd,
    createdAt: Date.now(),
  };
  saveTerminal(rec);
  return rec;
}

export async function openTerminal(opts: {
  name: string;
  cwd: string;
  command?: string;
  focus?: boolean;
}): Promise<Outcome> {
  const b = backend();
  if ("unsupported" in b) return fail(b.unsupported);
  const checked = checkName(opts.name);
  if ("error" in checked) return fail(checked.error);
  const records = await listTerminals(b);
  const clash = findTerminal(records, checked.name);
  if (clash) {
    return fail(
      `There is already a terminal named "${clash.name}". Focus it, close it first, or pick another name.`,
    );
  }
  // Register where we are first, so the new window can be left for this one by name.
  await claimSelf(b, opts.cwd).catch(() => undefined);
  const focus = opts.focus !== false;
  let id: string;
  try {
    id = await b.open({ name: checked.name, cwd: opts.cwd, ...(opts.command ? { command: opts.command } : {}), focus });
  } catch (e) {
    return fail(`Could not open a ${b.label} window: ${errorText(e)}`);
  }
  saveTerminal({
    name: checked.name,
    app: b.app,
    id,
    cwd: opts.cwd,
    ...(opts.command?.trim() ? { command: opts.command.trim() } : {}),
    createdAt: Date.now(),
  });
  // macOS puts a new Terminal window in front whatever we ask; put ours back.
  if (!focus) {
    const self = await b.selfId().catch(() => undefined);
    if (self) await b.focus(self).catch(() => undefined);
  }
  const what = opts.command?.trim() ? `running \`${opts.command.trim()}\`` : "with a shell";
  return done(`Opened "${checked.name}" ${what} in ${opts.cwd}${focus ? " — it has focus now" : " in the background"}.`);
}

export async function focusTerminal(name: string, cwd: string): Promise<Outcome> {
  const b = backend();
  if ("unsupported" in b) return fail(b.unsupported);
  await claimSelf(b, cwd).catch(() => undefined);
  const records = await listTerminals(b);
  const rec = findTerminal(records, name);
  if (!rec) return fail(unknownName(name, records));
  let ok: boolean;
  try {
    ok = await b.focus(rec.id);
  } catch (e) {
    return fail(`Could not focus "${rec.name}": ${errorText(e)}`);
  }
  if (!ok) {
    forgetTerminal(rec.app, rec.id);
    return fail(`"${rec.name}" has been closed.`);
  }
  return done(`Switched to "${rec.name}".`);
}

export async function closeTerminal(name: string, cwd: string): Promise<Outcome> {
  const b = backend();
  if ("unsupported" in b) return fail(b.unsupported);
  const self = await claimSelf(b, cwd).catch(() => undefined);
  const records = await listTerminals(b);
  const rec = findTerminal(records, name);
  if (!rec) return fail(unknownName(name, records));
  if (self && rec.id === self.id) return fail(`"${rec.name}" is this terminal — it can't close itself.`);
  try {
    if (!(await b.close(rec.id))) {
      forgetTerminal(rec.app, rec.id);
      return fail(`"${rec.name}" was already closed.`);
    }
  } catch (e) {
    return fail(`Could not close "${rec.name}": ${errorText(e)}`);
  }
  forgetTerminal(rec.app, rec.id);
  return done(`Closed "${rec.name}".`);
}

export async function renameSelf(name: string, cwd: string): Promise<Outcome> {
  const b = backend();
  if ("unsupported" in b) return fail(b.unsupported);
  const checked = checkName(name);
  if ("error" in checked) return fail(checked.error);
  const self = await claimSelf(b, cwd);
  if (!self) return fail("Can't tell which window this is, so it can't be named.");
  const clash = findTerminal(await listTerminals(b), checked.name);
  if (clash && clash.id !== self.id) return fail(`"${clash.name}" is already another terminal's name.`);
  saveTerminal({ ...self, name: checked.name });
  return done(`This terminal is "${checked.name}" now.`);
}

/**
 * Is the window this process runs in the one in front? For voice (privateer-speak): a
 * new window can't learn that from the terminal until focus next changes. undefined
 * when it can't tell — an unsupported terminal, or no tty.
 */
export async function thisTerminalIsFront(): Promise<boolean | undefined> {
  const b = backend();
  if ("unsupported" in b) return undefined;
  try {
    const id = await b.selfId();
    return id ? await b.isFront(id) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Report whether this window is in front each time that changes, for terminals that
 * can't tell the program inside themselves (mintty on Windows — see backends.ts). For
 * privateer-speak's watchFocus; elsewhere the terminal's own focus reports do this, and
 * it watches nothing.
 */
export function watchThisTerminalFocus(report: (front: boolean) => void): () => void {
  const b = backend();
  if ("unsupported" in b || !b.watchFront) return () => undefined;
  let stop: (() => void) | undefined;
  let stopped = false;
  void b
    .selfId()
    .then((id) => {
      if (id && !stopped) stop = b.watchFront!(id, report);
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    stop?.();
  };
}

export interface TerminalListing {
  records: TerminalRecord[];
  selfId?: string;
}

export async function terminalListing(cwd: string): Promise<TerminalListing | { unsupported: string }> {
  const b = backend();
  if ("unsupported" in b) return b;
  const self = await claimSelf(b, cwd).catch(() => undefined);
  return { records: await listTerminals(b), ...(self ? { selfId: self.id } : {}) };
}

export function describeListing(l: TerminalListing): string {
  if (!l.records.length) return "No named terminals yet.";
  return l.records
    .map((r) => {
      const here = r.id === l.selfId ? "  ← this one" : "";
      const what = r.command ? ` — ${r.command}` : "";
      return `${r.name}: ${r.cwd}${what}${here}`;
    })
    .join("\n");
}

function unknownName(name: string, records: readonly TerminalRecord[]): string {
  const names = records.map((r) => r.name);
  return names.length
    ? `No terminal named "${name}". Named terminals: ${names.join(", ")}.`
    : `No terminal named "${name}", and none are open yet.`;
}
