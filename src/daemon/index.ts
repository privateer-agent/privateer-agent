import type { Server } from "node:net";
import type { ToolSet } from "ai";
import { loadConfig } from "../config/load.ts";
import { createSession } from "../session.ts";
import { autoApproveGate } from "../permissions/gate.ts";
import { loadMcpServers, connectMcpServers } from "../mcp/client.ts";
import { RelayClient } from "../remote/relayClient.ts";
import { hasCredentials, revokeChildSession, apiRequest } from "../auth/privateer.ts";
import {
  loadRoutines,
  upsertRoutine,
  findRoutine,
  removeRoutine,
  addPendingRelay,
  drainPendingRelay,
  addPendingCloud,
  loadPendingCloud,
  savePendingCloud,
  type PendingCloud,
  routineRelayId,
} from "../routines/store.ts";
import type { Routine } from "../routines/schema.ts";
import { triggerError, computeNextRun, advanceAfterRun } from "../routines/trigger.ts";
import { splitRoutineTools, filterMcpTools } from "../routines/toolSelect.ts";
import { deliver, type RelayPusher, type CloudPusher } from "../routines/delivery.ts";
import { sealJson, decodeAccountPublicKey } from "../crypto/outboxSeal.ts";
import { redactText, collectSecrets } from "../util/redact.ts";
import { startIpcServer, type IpcRequest, type IpcResponse } from "./ipc.ts";

// The safe, read-only-plus-web toolset for unattended runs. No write/edit/bash, so
// a routine firing with nobody watching can't mutate the filesystem or shell out.
const SAFE_TOOLS = ["read", "glob", "grep", "web_fetch", "web_search"];

const TICK_MS = 60_000; // scan for due routines once a minute

// Max plaintext bytes sealed into one cloud-outbox item. Kept well under the
// server's ~64KiB plaintext / 128KiB base64 caps, with headroom for JSON escaping
// and the sealed-box overhead. The outbox carries summaries, not full transcripts.
const MAX_CLOUD_PLAINTEXT = 45_000;

function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// Render a run's result as a self-contained markdown document for file/notice output.
function formatResult(routine: Routine, body: string, status: "ok" | "error", error?: string): string {
  const when = new Date().toISOString();
  const head = `# ${routine.name}\n\n_${when} · ${status}${routine.model ? ` · ${routine.model}` : ""}_\n\n`;
  if (status === "error") return `${head}**Run failed:** ${error ?? "unknown error"}\n\n${body}`.trimEnd() + "\n";
  return `${head}${body.trim() || "(no output)"}\n`;
}

export class Daemon {
  private server?: Server;
  private timer?: ReturnType<typeof setInterval>;
  private readonly startedAt = Date.now();
  // Set of routine ids currently executing, so a slow run can't be re-entered by
  // the next tick.
  private readonly running = new Set<string>();
  // Outbound relay connection to the Privateer server, opened lazily when a signed-in
  // user has a routine that delivers over `relay`. Pushes results to an attached
  // controller (e.g. the mobile app) in real time.
  private relay?: RelayClient;
  // Best-effort "is a controller attached right now?" — set on controller_attached,
  // cleared when our socket drops. Used to decide push-live vs queue-for-later.
  private controllerAttached = false;
  // The app sent `terminate` (End remote access): keep the relay down until the
  // daemon restarts, even if routine edits re-run syncRelay. Results still queue
  // durably and deliver over the other channels meanwhile.
  private relayTerminated = false;
  // Push a result live if a controller is attached; otherwise persist it to the
  // pending queue so it flushes the moment the app next attaches. Either path is
  // durable, so delivery treats both as handled.
  private readonly pushRelay: RelayPusher = (routine, content) => {
    if (this.controllerAttached && this.relay?.sendRoutineResult(routine.name, content)) return "live";
    addPendingRelay({ routine: routine.name, at: new Date().toISOString(), content });
    return "queued";
  };

  // Account outbox public key, fetched lazily and cached for the daemon's lifetime.
  // The key is write-once/immutable server-side, so it never changes under us; a
  // restart re-fetches it. Undefined until first successful fetch (or if the app
  // hasn't published one yet, in which case cloud items stay queued).
  private outboxPub?: Uint8Array;

  // Seal a `cloud`-delivery result to the account outbox and POST it, or persist it
  // to the pending-cloud buffer to flush later. Both outcomes are durable.
  private readonly pushCloud: CloudPusher = async (routine, content, status) => {
    const at = new Date().toISOString();
    if (await this.postOutbox(routine.name, at, status, content)) return "sent";
    addPendingCloud({ routine: routine.name, at, status, content });
    return "queued";
  };

  start(): void {
    // Prime nextRun for any routine missing one, then start the loop + IPC server.
    this.primeSchedule();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.server = startIpcServer((req) => this.handleIpc(req));
    this.syncRelay();
    // Flush any cloud results buffered while the daemon was down / offline.
    void this.flushPendingCloud();
    const count = loadRoutines().filter((r) => r.enabled).length;
    log(`daemon started (pid ${process.pid}); ${count} enabled routine(s). Tick every ${TICK_MS / 1000}s.`);
    // Fire an immediate scan so a just-due routine doesn't wait a full minute.
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.server?.close();
    this.relay?.stop();
  }

  // Open the relay connection when it's both wanted (a signed-in account + at least
  // one enabled routine delivering over `relay`) and not already up. Started ahead
  // of fire time so it's connected when a routine actually pushes. We never tear it
  // down once up — an idle authenticated socket is cheap and reconnects itself.
  private syncRelay(): void {
    if (this.relay || this.relayTerminated) return;
    if (!hasCredentials()) return;
    const wantsRelay = loadRoutines().some((r) => r.enabled && r.delivery.includes("relay"));
    if (!wantsRelay) return;
    this.relay = new RelayClient({
      // The daemon publishes results but is not a drivable terminal: ignore any
      // prompts/approvals a controller might send.
      onPrompt: () => {},
      onInterrupt: () => {},
      onApprovalResponse: () => {},
      onControllerAttached: () => this.onControllerAttached(),
      onAttachment: () => {},
      onTerminate: () => {
        this.relayTerminated = true;
        this.controllerAttached = false;
        this.relay?.stop();
        this.relay = undefined;
        log("relay terminated from the app; staying offline until the daemon restarts");
      },
      onStatus: (text) => log(`relay: ${text}`),
      onDisconnected: () => {
        this.controllerAttached = false;
      },
    }, {
      // Stable identity so the daemon shows up as one recognizable terminal in the
      // app across restarts, instead of a fresh random "terminal-xxxx" each boot.
      termId: routineRelayId(),
      label: "Privateer Routines",
    });
    void this.relay.start();
    log("relay connection starting (routine has relay delivery + account signed in)");
  }

  // The app attached: greet it, then flush any routine results that finished while it
  // was closed so it catches up immediately (in fire order).
  private onControllerAttached(): void {
    this.controllerAttached = true;
    this.relay?.sendSnapshot([{ kind: "notice", text: "Privateer routines — results will appear here as they run." }]);
    const pending = drainPendingRelay();
    if (pending.length === 0) return;
    log(`controller attached — flushing ${pending.length} pending routine result(s)`);
    for (const p of pending) this.relay?.sendRoutineResult(p.routine, p.content);
  }

  // ── Cloud outbox (sealed store-and-forward) ────────────────────────────────

  // Fetch (once) and cache the account's published outbox public key. Returns
  // undefined when we're offline, the request fails, or the app hasn't published a
  // key yet — callers treat that as "can't seal right now" and buffer instead.
  private async ensureOutboxPub(): Promise<Uint8Array | undefined> {
    if (this.outboxPub) return this.outboxPub;
    try {
      const res = await apiRequest("/api/outbox/pubkey");
      if (!res.ok) return undefined;
      const data = (await res.json()) as { outboxPublicKey?: string | null };
      if (!data.outboxPublicKey) return undefined; // app hasn't published its key yet
      this.outboxPub = decodeAccountPublicKey(data.outboxPublicKey);
      return this.outboxPub;
    } catch {
      return undefined; // network/auth failure — retried on the next attempt
    }
  }

  // Seal one result to the account outbox key and POST the ciphertext. Returns true
  // only when the server accepted it. The sealed plaintext is a small JSON envelope
  // the app opens with its master key (shape kept in sync with the client's outbox
  // fetch path). The body is bounded so the sealed item stays under the server caps.
  private async postOutbox(routine: string, at: string, status: "ok" | "error", content: string): Promise<boolean> {
    const pub = await this.ensureOutboxPub();
    if (!pub) return false;
    const body =
      content.length > MAX_CLOUD_PLAINTEXT ? content.slice(0, MAX_CLOUD_PLAINTEXT) + "\n…truncated" : content;
    const sealed = sealJson(pub, { v: 1, kind: "routine", name: routine, status, at, content: body });
    try {
      const res = await apiRequest("/api/outbox", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sealed }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Retry any cloud items that failed to post earlier. Stops at the first item that
  // still fails so the queue stays in fire order and a persistent failure (offline /
  // key unpublished) doesn't burn requests on every entry each tick.
  private async flushPendingCloud(): Promise<void> {
    if (!hasCredentials()) return;
    const queue = loadPendingCloud();
    if (queue.length === 0) return;
    const remaining: PendingCloud[] = [];
    for (const p of queue) {
      if (remaining.length === 0 && (await this.postOutbox(p.routine, p.at, p.status, p.content))) continue;
      remaining.push(p);
    }
    if (remaining.length !== queue.length) {
      savePendingCloud(remaining);
      log(`flushed ${queue.length - remaining.length} pending cloud outbox item(s); ${remaining.length} remaining`);
    }
  }

  private primeSchedule(): void {
    for (const r of loadRoutines()) {
      if (!r.enabled) continue;
      if (r.nextRun && !Number.isNaN(Date.parse(r.nextRun))) continue;
      const nr = computeNextRun(r);
      if (nr) this.persistRun(r.id, { nextRun: nr.toISOString() });
    }
  }

  private async tick(): Promise<void> {
    // Opportunistically retry buffered cloud items (no-op when the queue is empty).
    void this.flushPendingCloud();
    const now = Date.now();
    for (const r of loadRoutines()) {
      if (!r.enabled || this.running.has(r.id)) continue;
      if (triggerError(r)) continue; // skip malformed triggers
      if (!r.nextRun) {
        const nr = computeNextRun(r);
        this.persistRun(r.id, { nextRun: nr?.toISOString() });
        continue;
      }
      if (Date.parse(r.nextRun) <= now) {
        await this.runRoutine(r);
      }
    }
  }

  // Execute a routine to completion and deliver the result. Advances nextRun past
  // now afterwards (skipping any backlog) so at most one run fires per tick.
  async runRoutine(routine: Routine): Promise<IpcResponse> {
    if (this.running.has(routine.id)) return { ok: false, message: "already running" };
    this.running.add(routine.id);
    log(`running routine "${routine.name}"`);

    const config = loadConfig();
    const modelSpec = routine.model ?? config.defaultModel;
    const split = splitRoutineTools(routine.tools);
    // If the routine names no builtin tools, it still gets the safe read/web set —
    // a routine that only lists MCP selectors shouldn't lose the ability to read.
    const allowedTools = split.builtin.length > 0 ? split.builtin : SAFE_TOOLS;
    const wantsEmail = routine.delivery.includes("email");

    // MCP tools are fulfilled inside the agent turn. Two grants exist: explicit
    // "<server>__<tool>" selectors in routine.tools (least privilege: only the named
    // servers are launched and only the selected tools exposed), and the legacy email
    // delivery, which exposes every configured server so the mail tool is reachable.
    // Either way, egress stays an explicit tool action rather than a side channel.
    let extraTools: ToolSet | undefined;
    let closeMcp: (() => void) | undefined;
    let prompt = routine.prompt;
    if (split.mcp.length > 0 || wantsEmail) {
      try {
        const all = loadMcpServers(routine.cwd);
        for (const s of split.servers) {
          if (!all[s]) log(`  mcp: server "${s}" not configured in mcp.json — skipping`);
        }
        const servers = wantsEmail
          ? all
          : Object.fromEntries(Object.entries(all).filter(([name]) => split.servers.includes(name)));
        const conn = await connectMcpServers(servers, routine.cwd, autoApproveGate);
        const selected = filterMcpTools(conn.tools, split.mcp);
        // Email needs every server's tools (the mail tool isn't in the selectors);
        // otherwise expose only what the routine was granted.
        extraTools = wantsEmail ? conn.tools : selected;
        closeMcp = () => conn.clients.forEach((c) => c.close());
        if (split.mcp.length > 0 && Object.keys(selected).length === 0) {
          log(`  mcp: selectors matched no tools (${split.mcp.join(", ")})`);
        }
        if (wantsEmail) {
          prompt +=
            "\n\nWhen finished, email the result to the account owner using the available mail tool " +
            "(e.g. a Gmail create/send tool). Keep the subject short and put the summary in the body.";
        }
      } catch (err) {
        log(`  mcp setup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let out = "";
    let status: "ok" | "error" = "ok";
    let error: string | undefined;
    try {
      const session = createSession({
        config,
        modelSpec,
        cwd: routine.cwd,
        gate: autoApproveGate,
        confineToCwd: true,
        allowedTools,
        extraTools,
      });
      for await (const ev of session.engine.send(prompt)) {
        if (ev.type === "text") out += ev.text;
        else if (ev.type === "error") {
          status = "error";
          error = ev.error;
        }
      }
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
    } finally {
      closeMcp?.();
    }

    const content = formatResult(routine, out, status, error);
    const report = await deliver(routine, content, status, {
      pushRelay: this.pushRelay,
      pushCloud: this.pushCloud,
      webhooks: config.webhooks,
      redact: (text) => redactText(text, collectSecrets(config.providers)),
    });
    log(`  "${routine.name}" ${status}; delivered via ${report.delivered.join(", ") || "(none)"}`);

    // Recurring routines reschedule; one-offs disable themselves after firing.
    this.persistRun(routine.id, {
      lastRun: new Date().toISOString(),
      lastStatus: status,
      lastError: error,
      ...advanceAfterRun(routine),
    });
    this.running.delete(routine.id);
    return { ok: status === "ok", message: report.delivered.join(", ") || undefined };
  }

  // Merge run bookkeeping into the persisted routine, re-reading first so we don't
  // clobber concurrent IPC edits (add/pause/remove).
  private persistRun(id: string, patch: Partial<Routine>): void {
    const current = findRoutine(loadRoutines(), id);
    if (!current) return;
    upsertRoutine({ ...current, ...patch });
  }

  private async handleIpc(req: IpcRequest): Promise<IpcResponse> {
    switch (req.cmd) {
      case "status":
        return { ok: true, pid: process.pid, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000), routines: loadRoutines() };
      case "list":
        return { ok: true, routines: loadRoutines() };
      case "add": {
        const err = triggerError(req.routine);
        if (err) return { ok: false, message: `invalid trigger: ${err}` };
        const nr = computeNextRun(req.routine);
        upsertRoutine({ ...req.routine, nextRun: nr?.toISOString() });
        this.syncRelay(); // connect the relay if this routine introduced relay delivery
        return { ok: true, message: `routine "${req.routine.name}" saved`, routines: loadRoutines() };
      }
      case "remove": {
        const removed = removeRoutine(req.idOrName);
        return removed
          ? { ok: true, message: `removed "${removed.name}"`, routines: loadRoutines() }
          : { ok: false, message: `no routine "${req.idOrName}"` };
      }
      case "pause":
      case "resume": {
        const r = findRoutine(loadRoutines(), req.idOrName);
        if (!r) return { ok: false, message: `no routine "${req.idOrName}"` };
        const enabled = req.cmd === "resume";
        const nr = enabled ? computeNextRun(r)?.toISOString() : undefined;
        upsertRoutine({ ...r, enabled, nextRun: nr });
        if (enabled) this.syncRelay();
        return { ok: true, message: `${enabled ? "resumed" : "paused"} "${r.name}"`, routines: loadRoutines() };
      }
      case "run-now": {
        const r = findRoutine(loadRoutines(), req.idOrName);
        if (!r) return { ok: false, message: `no routine "${req.idOrName}"` };
        // Fire in the background so the IPC caller isn't blocked on a long run.
        void this.runRoutine(r);
        return { ok: true, message: `running "${r.name}" now` };
      }
      case "reload":
        this.primeSchedule();
        this.syncRelay();
        return { ok: true, message: "schedule reloaded", routines: loadRoutines() };
      default:
        return { ok: false, message: "unknown command" };
    }
  }
}

// Entry point for `privateer daemon`.
export function runDaemon(): void {
  const daemon = new Daemon();
  daemon.start();
  const shutdown = () => {
    log("shutting down");
    daemon.stop();
    // Release this process's Privateer session so the daemon drops off the
    // app's Linked Devices immediately (best effort, then exit regardless).
    void revokeChildSession().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
