// Child → parent approval/prompt relay for subagents.
//
// pi-subagents runs each subagent as a headless child `pi` process with stdin
// IGNORED (`-p --mode json`), so the child's permission gate has no interactive
// way to reach a human. When the child is guarded by privateer's moat (the
// discovered gate shim) a gated action would otherwise just fail-closed (deny).
// This module gives that child a way OUT: it writes its approval request to a
// per-session directory on disk; the PARENT privateer session (which owns the
// RemoteBridge / relay to the app) watches that directory, relays the request to
// the phone for Allow/Deny, and writes the answer back as a reply file the child
// is polling for.
//
// Why our own channel and not pi-subagents' supervisor channel: we own BOTH
// processes, and the gate ask is a Pi permission decision — not a
// `contact_supervisor` tool call — so piggy-backing on pi-subagents' internal
// channel would couple us to its provisioning. A privateer-owned dir, addressed
// by an env var we set (inherited through pi-subagents' `{...process.env}` spawn),
// is fully under our control and unit-testable without a live Pi.
//
// Transport shape (mirrors pi-subagents' own request/reply-file dance so the
// semantics are familiar): `<dir>/requests/<id>.json` written atomically by the
// child; `<dir>/replies/<id>.json` written atomically by the parent; the parent
// deletes the request once answered. Everything is fail-closed: no parent, a gone
// controller, a timeout, or an abort all resolve the child to "deny"/null.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// The env var carrying the channel dir to a subagent child. Set by the parent into
// its OWN process.env before subagents spawn, so pi-subagents' `{...process.env}`
// spawn inherits it into every (possibly nested) child.
export const SUBAGENT_CHANNEL_ENV = "PRIVATEER_SUBAGENT_CHANNEL";

// A relayed permission approval. `kind`/`title`/`detail` mirror PermissionRequest
// so the parent can hand it straight to the bridge's requestApproval.
export interface ApprovalAsk {
  type: "approval";
  kind?: string;
  title: string;
  detail: string;
}

// A relayed selection prompt (an extension's ctx.ui.select in the child).
export interface SelectAsk {
  type: "select";
  title: string;
  options: { value: string; label: string; hint?: string }[];
  current?: string;
}

// A relayed free-form text prompt (an extension's ctx.ui.input in the child).
export interface InputAsk {
  type: "input";
  title: string;
  placeholder?: string;
}

export type SubagentAsk = ApprovalAsk | SelectAsk | InputAsk;

// The parent's answer. `decision` for approvals ("allow"/"deny"); `value` for
// select/input (the chosen value / typed line, or null for a dismiss/deny).
export interface SubagentReply {
  decision?: "allow" | "deny";
  value?: string | null;
}

interface RequestEnvelope {
  id: string;
  ask: SubagentAsk;
  // The subagent that raised it, for display/audit (best-effort; from env).
  agent?: string;
}

interface ReplyEnvelope {
  id: string;
  reply: SubagentReply;
}

// Deterministic per-session channel dir. Keyed by the PARENT session id so a parent
// watches exactly the children it spawned, and two concurrent parents never cross
// wires. Under the OS temp dir (world-unreadable 0700), never the repo/agent dir.
export function channelDirForSession(sessionId: string): string {
  const safe = sessionId.replace(/[^\w.-]+/g, "_") || "session";
  return join(tmpdir(), "privateer-subagent-channels", safe);
}

function requestsDir(dir: string): string {
  return join(dir, "requests");
}
function repliesDir(dir: string): string {
  return join(dir, "replies");
}

// Create the channel dir tree (idempotent). Parent calls this before advertising the
// env var; child tolerates a missing tree by treating it as "no parent" (deny).
export function ensureChannelDir(dir: string): void {
  mkdirSync(requestsDir(dir), { recursive: true, mode: 0o700 });
  mkdirSync(repliesDir(dir), { recursive: true, mode: 0o700 });
}

// Atomic JSON write: write a sibling temp file then rename, so a reader never sees a
// half-written file (rename is atomic within a dir on POSIX).
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function safeUnlink(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* already gone */
  }
}

// ── child side ───────────────────────────────────────────────────────────────

export interface AskOptions {
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  agent?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000; // match pi-subagents' 10-min ask ceiling
const DEFAULT_POLL_MS = 200;

// Forward an ask to the parent and await its reply. Resolves to the reply, or null
// on timeout / abort / no channel — every non-answer is a fail-closed null so the
// caller (the gate) denies. Safe to call from a headless child with no stdio.
export async function askParent(dir: string, ask: SubagentAsk, opts: AskOptions = {}): Promise<SubagentReply | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const id = randomUUID();
  const reqPath = join(requestsDir(dir), `${id}.json`);
  const replyPath = join(repliesDir(dir), `${id}.json`);
  try {
    ensureChannelDir(dir);
    writeJsonAtomic(reqPath, { id, ask, agent: opts.agent } satisfies RequestEnvelope);
  } catch {
    return null; // no channel / unwritable → fail closed
  }

  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (opts.signal?.aborted) return null;
      const reply = readJson<ReplyEnvelope>(replyPath);
      if (reply && reply.id === id) return reply.reply ?? null;
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), opts.signal);
    }
  } finally {
    // Best-effort cleanup so a timed-out/aborted request doesn't linger and a stale
    // reply doesn't confuse a later run (ids are unique, but keep the dir tidy).
    safeUnlink(reqPath);
    safeUnlink(replyPath);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ── parent side ──────────────────────────────────────────────────────────────

export interface WatcherHandle {
  stop: () => void;
}

// The parent's answerer: given a child's ask, return the reply (relaying to the app
// and awaiting the human, in the real wiring). Returning a rejecting/denying reply
// or throwing both fail closed — the watcher writes a deny/null reply on a throw.
export type AskHandler = (ask: SubagentAsk, meta: { id: string; agent?: string }) => Promise<SubagentReply>;

export interface WatchOptions {
  pollMs?: number;
  onError?: (err: unknown) => void;
}

// Watch the channel for child requests, answer each via `handler`, and write the
// reply back (then delete the request). Requests are handled at most once — an id is
// marked in-flight before the async handler runs so a fast poll can't double-serve.
// A handler that throws yields a fail-closed reply (deny / null value). Returns a
// handle whose stop() ends the poll loop.
export function watchSubagentChannel(dir: string, handler: AskHandler, opts: WatchOptions = {}): WatcherHandle {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const inFlight = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const failClosed = (ask: SubagentAsk): SubagentReply =>
    ask.type === "approval" ? { decision: "deny" } : { value: null };

  const serve = (id: string, env: RequestEnvelope): void => {
    inFlight.add(id);
    void Promise.resolve()
      .then(() => handler(env.ask, { id, agent: env.agent }))
      .catch((err) => {
        opts.onError?.(err);
        return failClosed(env.ask);
      })
      .then((reply) => {
        try {
          writeJsonAtomic(join(repliesDir(dir), `${id}.json`), { id, reply } satisfies ReplyEnvelope);
        } catch (err) {
          opts.onError?.(err);
        } finally {
          safeUnlink(join(requestsDir(dir), `${id}.json`));
          inFlight.delete(id);
        }
      });
  };

  const tick = (): void => {
    if (stopped) return;
    try {
      ensureChannelDir(dir);
      for (const name of readdirSync(requestsDir(dir))) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -5);
        if (inFlight.has(id)) continue;
        const env = readJson<RequestEnvelope>(join(requestsDir(dir), name));
        if (env && env.id === id && env.ask) serve(id, env);
      }
    } catch (err) {
      opts.onError?.(err);
    }
    if (!stopped) timer = setTimeout(tick, pollMs);
  };

  tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
