import type { Server } from "node:net";
import type { ToolSet } from "ai";
import { loadConfig } from "../config/load.ts";
import { createSession } from "../session.ts";
import { autoApproveGate } from "../permissions/gate.ts";
import { loadMcpServers, connectMcpServers } from "../mcp/client.ts";
import { RelayClient } from "../remote/relayClient.ts";
import { hasCredentials } from "../auth/privateer.ts";
import {
  loadRoutines,
  upsertRoutine,
  findRoutine,
  removeRoutine,
  addPendingRelay,
  drainPendingRelay,
  routineRelayId,
} from "../routines/store.ts";
import type { Routine } from "../routines/schema.ts";
import { triggerError, computeNextRun, advanceAfterRun } from "../routines/trigger.ts";
import { deliver, type RelayPusher } from "../routines/delivery.ts";
import { startIpcServer, type IpcRequest, type IpcResponse } from "./ipc.ts";

// The safe, read-only-plus-web toolset for unattended runs. No write/edit/bash, so
// a routine firing with nobody watching can't mutate the filesystem or shell out.
const SAFE_TOOLS = ["read", "glob", "grep", "web_fetch", "web_search"];

const TICK_MS = 60_000; // scan for due routines once a minute

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
  // Push a result live if a controller is attached; otherwise persist it to the
  // pending queue so it flushes the moment the app next attaches. Either path is
  // durable, so delivery treats both as handled.
  private readonly pushRelay: RelayPusher = (routine, content) => {
    if (this.controllerAttached && this.relay?.sendRoutineResult(routine.name, content)) return "live";
    addPendingRelay({ routine: routine.name, at: new Date().toISOString(), content });
    return "queued";
  };

  start(): void {
    // Prime nextRun for any routine missing one, then start the loop + IPC server.
    this.primeSchedule();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.server = startIpcServer((req) => this.handleIpc(req));
    this.syncRelay();
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
    if (this.relay) return;
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

  private primeSchedule(): void {
    for (const r of loadRoutines()) {
      if (!r.enabled) continue;
      if (r.nextRun && !Number.isNaN(Date.parse(r.nextRun))) continue;
      const nr = computeNextRun(r);
      if (nr) this.persistRun(r.id, { nextRun: nr.toISOString() });
    }
  }

  private async tick(): Promise<void> {
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
    const allowedTools = routine.tools ?? SAFE_TOOLS;

    // Email delivery is fulfilled inside the agent turn: connect MCP servers, expose
    // their tools, and instruct the agent to send the result. This keeps plaintext
    // egress an explicit tool action rather than a side channel.
    let extraTools: ToolSet | undefined;
    let closeMcp: (() => void) | undefined;
    let prompt = routine.prompt;
    if (routine.delivery.includes("email")) {
      try {
        const conn = await connectMcpServers(loadMcpServers(routine.cwd), routine.cwd, autoApproveGate);
        extraTools = conn.tools;
        closeMcp = () => conn.clients.forEach((c) => c.close());
        prompt +=
          "\n\nWhen finished, email the result to the account owner using the available mail tool " +
          "(e.g. a Gmail create/send tool). Keep the subject short and put the summary in the body.";
      } catch (err) {
        log(`  email setup failed: ${err instanceof Error ? err.message : String(err)}`);
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
    const report = deliver(routine, content, status, { pushRelay: this.pushRelay });
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
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
