import type { Server } from "node:net";
import { readFileSync } from "node:fs";
// Pi session stack. The daemon MUST be launched after ./boot.ts (env +
// attestation dispatcher) — these are evaluated on import.
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { agentDir, configPath } from "../config/paths.ts";
import { agentVersion } from "../config/version.ts";
import { createEngineEventAdapter } from "../bridge/engineAdapter.ts";
import { makePermissionGate, type GateController } from "../ext/permissionGate.ts";
import { makePiPrivacyExtension } from "pi-privacy";
import { makeAccountProvider } from "../providers/account.ts";
import { RelayClient } from "../remote/relayClient.ts";
import { hasCredentials, revokeLocalSessions, revokeAccountSession, apiRequest, spawnAccountCredentials } from "../auth/privateer.ts";
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
import { splitRoutineTools } from "../routines/toolSelect.ts";
import { deliver, type RelayPusher, type CloudPusher } from "../routines/delivery.ts";
import { sealJson, decodeAccountPublicKey } from "../crypto/outboxSeal.ts";
import { redactText, collectSecrets } from "../util/redact.ts";
import { startIpcServer, type IpcRequest, type IpcResponse } from "./ipc.ts";

// The safe, read-only toolset for unattended runs — Pi builtins with no
// write/edit/bash, so a routine firing with nobody watching can't mutate the
// filesystem or shell out. (0.2's web_fetch/web_search return once the web tools
// land in Phase 5.) Safety is the tool restriction; the gate auto-approves what's
// allowed but still fail-closes a dangerous shell command headlessly.
const SAFE_TOOLS = ["read", "grep", "find", "ls"];

const TICK_MS = 60_000; // scan for due routines once a minute
const MAX_CLOUD_PLAINTEXT = 45_000;

interface DaemonConfig {
  defaultModel: string;
  webhooks?: Record<string, { url: string; secret?: string; headers?: Record<string, string> }>;
  providers?: Record<string, { apiKey?: string } | undefined>;
}

// Minimal config read (webhooks + providers-for-redaction + default model). The
// full config layer is a Phase-7 port; the daemon only needs these fields.
function loadDaemonConfig(): DaemonConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    return {
      defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : "openrouter/openai/gpt-4o-mini",
      webhooks: raw.webhooks,
      providers: raw.providers,
    };
  } catch {
    return { defaultModel: "openrouter/openai/gpt-4o-mini" };
  }
}

// Split a "provider:model" (0.2) or "provider/model" (new) spec on its first
// separator. Model ids themselves contain "/", so we key off the first delimiter.
function parseSpec(spec: string): { provider: string; modelId: string } {
  const i = spec.indexOf(":");
  const j = spec.indexOf("/");
  const sep = i === -1 ? j : j === -1 ? i : Math.min(i, j);
  if (sep <= 0) return { provider: spec, modelId: "" };
  return { provider: spec.slice(0, sep), modelId: spec.slice(sep + 1) };
}

function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

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
  private readonly running = new Set<string>();
  private relay?: RelayClient;
  private controllerAttached = false;
  private relayTerminated = false;

  private readonly pushRelay: RelayPusher = (routine, content) => {
    if (this.controllerAttached && this.relay?.sendRoutineResult(routine.name, content)) return "live";
    addPendingRelay({ routine: routine.name, at: new Date().toISOString(), content });
    return "queued";
  };

  private outboxPub?: Uint8Array;

  private readonly pushCloud: CloudPusher = async (routine, content, status) => {
    const at = new Date().toISOString();
    if (await this.postOutbox(routine.name, at, status, content)) return "sent";
    addPendingCloud({ routine: routine.name, at, status, content });
    return "queued";
  };

  start(): void {
    this.primeSchedule();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.server = startIpcServer((req) => this.handleIpc(req));
    this.syncRelay();
    void this.flushPendingCloud();
    const count = loadRoutines().filter((r) => r.enabled).length;
    log(`daemon started (pid ${process.pid}); ${count} enabled routine(s). Tick every ${TICK_MS / 1000}s.`);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.server?.close();
    this.relay?.stop();
  }

  private syncRelay(): void {
    if (this.relay || this.relayTerminated) return;
    if (!hasCredentials()) return;
    const wantsRelay = loadRoutines().some((r) => r.enabled && r.delivery.includes("relay"));
    if (!wantsRelay) return;
    this.relay = new RelayClient(
      {
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
      },
      { termId: routineRelayId(), label: "Privateer Routines" },
    );
    void this.relay.start();
    log("relay connection starting (routine has relay delivery + account signed in)");
  }

  private onControllerAttached(): void {
    this.controllerAttached = true;
    this.relay?.sendSnapshot([{ kind: "notice", text: "Privateer routines — results will appear here as they run." }]);
    // Version only — the routines terminal isn't a single-model session, so no
    // model field (and no cwd, per RelayClient.sendContext's non-PII stance).
    this.relay?.sendContext({ version: agentVersion() });
    const pending = drainPendingRelay();
    if (pending.length === 0) return;
    log(`controller attached — flushing ${pending.length} pending routine result(s)`);
    for (const p of pending) this.relay?.sendRoutineResult(p.routine, p.content);
  }

  // ── Cloud outbox (sealed store-and-forward) ────────────────────────────────

  private async ensureOutboxPub(): Promise<Uint8Array | undefined> {
    if (this.outboxPub) return this.outboxPub;
    try {
      const res = await apiRequest("/api/outbox/pubkey");
      if (!res.ok) return undefined;
      const data = (await res.json()) as { outboxPublicKey?: string | null };
      if (!data.outboxPublicKey) return undefined;
      this.outboxPub = decodeAccountPublicKey(data.outboxPublicKey);
      return this.outboxPub;
    } catch {
      return undefined;
    }
  }

  private async postOutbox(routine: string, at: string, status: "ok" | "error", content: string): Promise<boolean> {
    const pub = await this.ensureOutboxPub();
    if (!pub) return false;
    const body = content.length > MAX_CLOUD_PLAINTEXT ? content.slice(0, MAX_CLOUD_PLAINTEXT) + "\n…truncated" : content;
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
    void this.flushPendingCloud();
    const now = Date.now();
    for (const r of loadRoutines()) {
      if (!r.enabled || this.running.has(r.id)) continue;
      if (triggerError(r)) continue;
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

  // Execute a routine to completion and deliver the result. The one rewired seam:
  // drive a headless Pi session (auto-approve gate + restricted tool set) instead of
  // the old engine, collecting the text output.
  async runRoutine(routine: Routine): Promise<IpcResponse> {
    if (this.running.has(routine.id)) return { ok: false, message: "already running" };
    this.running.add(routine.id);
    log(`running routine "${routine.name}"`);

    const config = loadDaemonConfig();
    const modelSpec = routine.model ?? config.defaultModel;
    const split = splitRoutineTools(routine.tools);
    const allowedTools = split.builtin.length > 0 ? split.builtin : SAFE_TOOLS;
    if (split.mcp.length > 0 || routine.delivery.includes("email")) {
      log("  note: MCP tools + email delivery are not wired yet (Phase 5) — skipping those");
    }

    let out = "";
    let status: "ok" | "error" = "ok";
    let error: string | undefined;
    // Track this run's account inference session so it can be torn down when the
    // routine finishes — each run force-spawns a fresh one (below), so without this
    // a long-lived daemon would leave one orphaned account "device" per run lingering
    // in the app's Linked Devices until its token TTL.
    let servicesRef: { authStorage?: { remove?: (p: string) => void } } | null = null;
    let spawnedAccount = false;
    try {
      // Auto-approve (bypass) gate — safety is `tools: allowedTools`; a dangerous
      // shell command still fail-closes headlessly (localAsk denies).
      const gate: GateController = {
        getMode: () => "bypass",
        setMode: () => {},
        allowlist: [],
        allowedOutsideRoots: [],
        cwd: routine.cwd,
        confineToCwd: true,
        async localAsk() {
          return "deny";
        },
      };
      const services = await createAgentSessionServices({
        cwd: routine.cwd,
        agentDir: agentDir(),
        resourceLoaderOptions: {
          extensionFactories: [makePermissionGate(gate), makePiPrivacyExtension(), makeAccountProvider()] as any,
        },
      });
      servicesRef = services as any;

      const { provider, modelId } = parseSpec(modelSpec);
      if (provider === "privateer") {
        try {
          const creds = await spawnAccountCredentials();
          (services.authStorage as any).set("privateer", { type: "oauth", ...creds });
          spawnedAccount = true;
        } catch (e) {
          log(`  account channel unavailable: ${(e as Error).message}`);
        }
      }

      const model = (services.modelRegistry as any).find(provider, modelId);
      if (!model) {
        status = "error";
        error = `model ${provider}/${modelId} not found`;
      } else {
        const { session } = await createAgentSessionFromServices({
          services,
          sessionManager: SessionManager.inMemory(routine.cwd),
          model,
          tools: allowedTools,
        } as any);
        const adapter = createEngineEventAdapter();
        session.subscribe((ev: any) => {
          for (const ee of adapter.toEngineEvents(ev)) {
            if (ee.type === "text") out += ee.text;
            else if (ee.type === "error") {
              status = "error";
              error = ee.error;
            }
          }
        });
        await session.prompt(routine.prompt);
      }
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
    } finally {
      // Tear down THIS run's account inference session so it doesn't linger in the
      // app's Linked Devices after the routine finishes. Revoke only the account
      // session — the daemon's child API session (relay/outbox) must stay alive for
      // the daemon's lifetime and is revoked on shutdown. Also drop Pi's persisted
      // copy so a later run's fallback never reuses this revoked token. Best-effort;
      // the next run force-spawns a fresh account session.
      if (spawnedAccount) {
        try { await revokeAccountSession(); } catch { /* best effort — server TTL is the fallback */ }
        try { servicesRef?.authStorage?.remove?.("privateer"); } catch { /* nothing persisted */ }
      }
    }

    const content = formatResult(routine, out, status, error);
    const report = await deliver(routine, content, status, {
      pushRelay: this.pushRelay,
      pushCloud: this.pushCloud,
      webhooks: config.webhooks,
      redact: (text) => redactText(text, collectSecrets(config.providers)),
    });
    log(`  "${routine.name}" ${status}; delivered via ${report.delivered.join(", ") || "(none)"}`);

    this.persistRun(routine.id, {
      lastRun: new Date().toISOString(),
      lastStatus: status,
      lastError: error,
      ...advanceAfterRun(routine),
    });
    this.running.delete(routine.id);
    return { ok: status === "ok", message: report.delivered.join(", ") || undefined };
  }

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
        this.syncRelay();
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

// Entry point for `privateer daemon`. Caller must have imported ./boot.ts first.
export function runDaemon(): void {
  const daemon = new Daemon();
  daemon.start();
  const shutdown = () => {
    log("shutting down");
    daemon.stop();
    void revokeLocalSessions().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
