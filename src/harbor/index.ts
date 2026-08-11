import type { Server } from "node:net";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
// Pi session stack. The harbor MUST be launched after ./boot.ts (env +
// attestation dispatcher) — these are evaluated on import.
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { agentDir, configPath } from "../config/paths.ts";
import { agentVersion } from "../config/version.ts";
import { createEngineEventAdapter } from "../bridge/engineAdapter.ts";
import { type GateController } from "../ext/permissionGate.ts";
import { moatResourceOptions } from "../config/moat.ts";
import {
  rememberAccountCredential,
  persistAccountCredential,
  dropPersistedAccountCredential,
} from "../providers/account.ts";
// Pi-free static graph by design — see the header of piAuthStore.ts.
import { modelRegistryOf } from "../providers/piAuthStore.ts";
import { resolveDefaultModel } from "../providers/defaultModel.ts";
import { RelayClient, type TaskSpec } from "../remote/relayClient.ts";
import { createLiveTaskSession, type LiveTaskHandle } from "../remote/liveTaskSession.ts";
import { makeRoutinesControl } from "../remote/routinesControl.ts";
import { makeChannelsControl } from "../remote/channelsControl.ts";
import { makeMcpControl, mergeSealedMcpSecrets } from "../remote/mcpControl.ts";
import { makeWorkflowsControl } from "../remote/workflowsControl.ts";
import { runWorkflow as executeWorkflow, type RunnerDeps, type AgentRunSpec, type AgentRunResult, type ScriptRunResult } from "../workflows/runner.ts";
import type { Workflow, Step } from "../workflows/schema.ts";
import { readRunningPlatforms } from "../channels/status.ts";
import { terminalPublicKeyBase64 } from "../crypto/terminalKey.ts";
import { openJsonFromApp } from "../crypto/terminalUnseal.ts";
import { verifyChannelSave } from "../crypto/accountVerify.ts";
import { loadAccountSignKey, loadLastControlTs, saveLastControlTs } from "../crypto/accountTrust.ts";
import { authorizeControl } from "../remote/controlAuth.ts";
import { hasCredentials, revokeLocalSessions, revokeAccountSession, apiRequest, acquireAccountCredential, handleServerRevoke } from "../auth/privateer.ts";
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
  type OutboxKind,
  routineRelayId,
} from "../routines/store.ts";
import type { Routine } from "../routines/schema.ts";
import { triggerError, computeNextRun, advanceAfterRun } from "../routines/trigger.ts";
import { splitRoutineTools } from "../routines/toolSelect.ts";
import { resolveMcpSelection, readMcpInventory, type ResolvedMcpTools } from "../mcp/toolNames.ts";
import { deliver, type RelayPusher, type CloudPusher } from "../routines/delivery.ts";
import { ResultMedia, type StagedMedia } from "../routines/resultMedia.ts";
import { withBrief } from "../routines/resultBrief.ts";
import { ATTACH_RESULT_TOOL } from "../tools/attachResult.ts";
import { postOutbox as sealToOutbox } from "../outbox/cloudOutbox.ts";
import { redactText, collectSecrets } from "../util/redact.ts";
import { startIpcServer, sendToHarbor, describeRelay, formatDuration, HarborAlreadyRunningError, type IpcRequest, type IpcResponse, type RelayStatus } from "./ipc.ts";
import { serializeBuild } from "./buildLock.ts";
import { isHosted, publishRelayPub, webEnabled, mediaEnabled } from "../config/hosted.ts";
import { WEB_TOOL_NAMES } from "../tools/web.ts";
import { MEDIA_TOOL_NAMES } from "../tools/media.ts";
import { COMPOSE_TOOL_NAMES } from "../tools/videoCompose.ts";

// The safe, read-only toolset for unattended runs — Pi builtins with no
// write/edit/bash, so a routine firing with nobody watching can't mutate the
// filesystem or shell out. Safety is the tool restriction; the gate auto-approves
// what's allowed but still fail-closes a dangerous shell command headlessly.
const SAFE_TOOLS = ["read", "grep", "find", "ls"];

// Read-only in the same sense — they can't touch the filesystem or the shell — but
// they do send a derived query out to Privateer's servers, so they are a switch
// (webEnabled) rather than part of the unconditional safe set. When the switch is on
// they join the DEFAULT allow-list: the overwhelmingly common unattended request
// ("summarize today's news at 7pm") needs the live web and nothing else, and making
// the user hand-write an allow-list for it was the whole friction.
const WEB_TOOLS: string[] = [...WEB_TOOL_NAMES];

// Media generation (src/tools/media.ts) plus local composition (videoCompose.ts).
//
// Unlike the web tools these are deliberately NOT in the default allow-list, even with
// the switch on. Generation writes files and spends real credit — cents an image, up to
// a dollar a video clip — so an unattended routine gets them only by NAMING them, which
// makes "this routine can bill me for video" a decision someone made rather than a
// default they inherited. `media_capabilities` is free and read-only but stays with its
// siblings: on its own it would be a tool that only ever reports what the run can't do.
// Composition (video_compose) is deliberately NOT in this list: it is local ffmpeg work
// with no account, no network and no spend, so it stays grantable even with generation
// switched off — finishing the clips a previous run produced is exactly when that
// matters. See MEDIA_ALL for what actually gets registered.
const MEDIA_GEN_TOOLS: string[] = [...MEDIA_TOOL_NAMES];
const MEDIA_ALL: string[] = [...MEDIA_TOOL_NAMES, ...COMPOSE_TOOL_NAMES];

// Resolve a run's builtin allow-list. An explicit list wins, minus any web or media
// tools whose switch is off — a routine saved while one was on must not silently
// reference a tool that no longer registers.
function builtinToolsFor(explicit: string[]): string[] {
  const web = webEnabled();
  const media = mediaEnabled();
  if (explicit.length > 0) {
    return explicit.filter((t) => (web || !WEB_TOOLS.includes(t)) && (media || !MEDIA_GEN_TOOLS.includes(t)));
  }
  return web ? [...SAFE_TOOLS, ...WEB_TOOLS] : [...SAFE_TOOLS];
}

/** Every media tool name a routine may name, for the app's tool picker / docs. */
export function mediaToolNames(): string[] {
  return mediaEnabled() ? [...MEDIA_ALL] : [...COMPOSE_TOOL_NAMES];
}

const TICK_MS = 60_000; // scan for due routines once a minute
// Harbor hosted mode (isHosted): suspend after this much idle time with no work,
// and stay up if a routine is due within the lead window (avoids suspend→wake churn).
const HOSTED_IDLE_MS = Number(process.env.HARBOR_IDLE_MS) || 5 * 60_000;
const HOSTED_SUSPEND_MIN_LEAD_MS = Number(process.env.HARBOR_SUSPEND_MIN_LEAD_MS) || 2 * 60_000;
// How long a workflow `human_gate` (or a script-approval prompt) waits for the app to
// answer before it fail-closes to "no response" (the runner then defers the run). Bounds
// a stuck graph from pinning a `running` slot forever when the controller wanders off.
const GATE_TIMEOUT_MS = 5 * 60_000;
// How long a run waits for a newly-selected connector to hand over its tool list
// before giving up and saying so in the result (see warmMcpCache). Bounds a dead
// endpoint or an expired OAuth token from stalling a scheduled run.
const WARM_TIMEOUT_MS = Number(process.env.PRIVATEER_MCP_WARM_MS) || 30_000;
const WARM_POLL_MS = 250;

interface HarborConfig {
  defaultModel: string;
  webhooks?: Record<string, { url: string; secret?: string; headers?: Record<string, string> }>;
  providers?: Record<string, { apiKey?: string } | undefined>;
}

// Minimal config read (webhooks + providers-for-redaction + default model). The
// full config layer is a Phase-7 port; the harbor only needs these fields.
function loadHarborConfig(): HarborConfig {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    return {
      // config.defaultModel is the explicit choice; absent it, resolve (account default
      // when signed in, else BYO) rather than assuming a BYO OpenRouter key.
      defaultModel: resolveDefaultModel({ explicit: typeof raw.defaultModel === "string" ? raw.defaultModel : undefined }),
      webhooks: raw.webhooks,
      providers: raw.providers,
    };
  } catch {
    return { defaultModel: resolveDefaultModel() };
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

// Connector notes are things the RUN could not do — a selected connector that isn't
// configured, or one that wouldn't hand over a tool list. They ride the result
// because the alternative is the failure mode RoutineIssues exists to prevent: an
// empty answer three mornings running with no clue why.
function formatNotes(notes: string[]): string {
  if (notes.length === 0) return "";
  return `\n---\n\n${notes.map((n) => `> ⚠︎ ${n}`).join("\n>\n")}\n`;
}

function formatResult(routine: Routine, body: string, status: "ok" | "error", error?: string, notes: string[] = []): string {
  const when = new Date().toISOString();
  const head = `# ${routine.name}\n\n_${when} · ${status}${routine.model ? ` · ${routine.model}` : ""}_\n\n`;
  if (status === "error") return `${head}**Run failed:** ${error ?? "unknown error"}\n\n${body}${formatNotes(notes)}`.trimEnd() + "\n";
  return `${head}${body.trim() || "(no output)"}\n${formatNotes(notes)}`;
}

// Session construction is serialized process-wide — see harbor/buildLock.ts for why.
// Imported rather than defined here so the channels runtime can share the same lock.

// A short human title for an ad-hoc task: the app's explicit title, else the first
// non-empty line of the prompt, clipped. Exported for the signed-args round-trip test.
export function deriveTaskTitle(spec: TaskSpec): string {
  const explicit = spec.title?.trim();
  if (explicit) return explicit.slice(0, 80);
  const firstLine = spec.prompt.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "task";
  return firstLine.slice(0, 80);
}

function formatTaskResult(title: string, body: string, status: "ok" | "error", error?: string, model?: string, notes: string[] = []): string {
  const when = new Date().toISOString();
  const head = `# ${title}\n\n_${when} · ${status}${model ? ` · ${model}` : ""}_\n\n`;
  if (status === "error") return `${head}**Task failed:** ${error ?? "unknown error"}\n\n${body}${formatNotes(notes)}`.trimEnd() + "\n";
  return `${head}${body.trim() || "(no output)"}\n${formatNotes(notes)}`;
}

// Render a finished workflow run into the delivery/outbox markdown: the terminal status,
// the workflow-level `output:` (if any), and the halt reason for a failed/deferred run.
function formatWorkflowResult(name: string, result: { status: string; output: Record<string, unknown>; reason?: string }): string {
  const when = new Date().toISOString();
  const head = `# Workflow: ${name}\n\n_${when} · ${result.status}_\n\n`;
  const body = Object.keys(result.output).length > 0 ? "```json\n" + JSON.stringify(result.output, null, 2) + "\n```\n" : "";
  const reason = result.reason ? `\n${result.status === "success" ? "" : "**"}${result.reason}${result.status === "success" ? "" : "**"}\n` : "";
  return `${head}${body}${reason}`.trimEnd() + "\n";
}

// Canonical control-envelope args for a task_submit / task_spawn signature. MUST match
// the app's signer (client/services/accountSign.ts) byte-for-byte: the SAME key set with
// undefined → null, so the recursive-key-sorted JSON both sides sign is identical. A
// mismatch here fails the signature and the task is refused (fail-closed). Exported so
// the test pins the exact shape the app must sign.
export function taskControlArgs(spec: TaskSpec): Record<string, unknown> {
  return {
    prompt: spec.prompt,
    cwd: spec.cwd ?? null,
    model: spec.model ?? null,
    tools: spec.tools ?? null,
    title: spec.title ?? null,
  };
}

export class Harbor {
  private server?: Server;
  private timer?: ReturnType<typeof setInterval>;
  private readonly startedAt = Date.now();
  private readonly running = new Set<string>();
  private relay?: RelayClient;
  private controllerAttached = false;
  private relayTerminated = false;
  // Harbor hosted mode: last time a controller attached or a routine ran. Drives
  // idle-suspend (no `controller_detached` frame exists, so we gate on inactivity
  // + no live work rather than on controllerAttached, which never resets while the
  // socket stays open).
  private lastActivityAt = Date.now();
  // In-flight MCP tool-inventory rebuild, shared by every run that needs one.
  private warmInFlight?: Promise<void>;
  // Live, app-drivable sessions spawned on demand (task_spawn). Each has its OWN relay
  // terminal (task-<uuid>); the harbor just keeps handles so it can reap them on shutdown.
  private readonly liveTasks = new Map<string, LiveTaskHandle>();

  // App-facing routine management (list/save/delete/pause/run) over the harbor's
  // relay. Run-now is injected here since only the harbor can actually fire one;
  // webhook validation reads config fresh so a just-declared endpoint is honored.
  private readonly routines = makeRoutinesControl({
    defaultCwd: () => process.cwd(),
    webhookExists: (name) => !!loadHarborConfig().webhooks?.[name],
    runNow: (routine) => void this.runRoutine(routine),
  });

  // App-facing channel management (list/save/remove) over the harbor's relay. The
  // channels harbor (channels/run.ts) is a SEPARATE process that may be down, so
  // this edits config.json directly; `runningPlatforms` is a best-effort heartbeat
  // read for a live/offline badge, never a dependency. Edits apply on the channels
  // harbor's next restart (its deliberate fail-safe posture).
  private readonly channels = makeChannelsControl({
    runningPlatforms: () => readRunningPlatforms(),
  });

  // App-facing MCP connector management (list/save/set_enabled/remove) over the
  // harbor's relay — the harbor is the Node HOST that actually runs the adapter (a
  // phone/web client can't). Edits the SHARED agent/mcp-desktop.json + mcp.json, so a
  // machine has one MCP config whether it was set from the desktop (IPC) or the phone
  // (relay). Tokens ride in a SEALED box (applyMcpSave) — the relay never sees them.
  private readonly mcp = makeMcpControl();

  // App-facing workflow management (list/get/save/remove/run) over the harbor's relay.
  // Run-now is injected here since only the harbor owns the runner + its seams. A
  // workflow can carry a `script` step (RCE if forged), so every mutation is
  // account-signed + verified (guardControl) before reaching this control.
  private readonly workflows = makeWorkflowsControl({
    runNow: (wf) => void this.runWorkflow(wf),
  });

  // Pending human_gate / script-approval prompts a running workflow is blocked on,
  // keyed by the select/approval frame id. Resolved when the app answers (onSelectResponse
  // / onApprovalResponse) or when GATE_TIMEOUT_MS elapses (fail-closed → null).
  private readonly pendingGates = new Map<string, (value: string | null) => void>();

  private readonly pushRelay: RelayPusher = (routine, content) => {
    if (this.controllerAttached && this.relay?.sendRoutineResult(routine.name, content)) return "live";
    addPendingRelay({ routine: routine.name, at: new Date().toISOString(), content });
    return "queued";
  };

  private readonly pushCloud: CloudPusher = async (routine, content, status, media = []) => {
    const at = new Date().toISOString();
    if (await this.postOutbox(routine.name, at, status, content, "routine", media)) return "sent";
    // The queued copy keeps the attachment RECORDS, not the bytes: the files are
    // still on this disk, so a flush hours later re-reads them (and says so in the
    // body for any that have since gone). Buffering megabytes into a JSON queue
    // would be the same content twice, on a box that already has it.
    addPendingCloud({ routine: routine.name, at, status, content, ...(media.length ? { media } : {}) });
    return "queued";
  };

  async start(): Promise<void> {
    // Single-instance lock FIRST, before any other side effect: binding the IPC
    // socket is the machine's mutex. If a live harbor already holds it this throws
    // HarborAlreadyRunningError — two harbors under one ~/.privateer share a single
    // routineRelayId(), so a second would collide on the relay and double-fire
    // routines. Doing this first means a rejected second instance never publishes a
    // relay key, connects, or fires a tick.
    this.server = await startIpcServer((req) => this.handleIpc(req));
    // Hosted only: publish our relay pubkey for the host to bind into the SEV-SNP
    // report. Before syncRelay() so the key exists by the time we're reachable.
    publishRelayPub();
    this.primeSchedule();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.syncRelay();
    void this.flushPendingCloud();
    const count = loadRoutines().filter((r) => r.enabled).length;
    log(`harbor started (pid ${process.pid}); ${count} enabled routine(s). Tick every ${TICK_MS / 1000}s.`);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.server?.close();
    this.relay?.stop();
    // Tear down any live spawned sessions (each revokes its own account session).
    for (const handle of this.liveTasks.values()) void handle.stop();
    this.liveTasks.clear();
  }

  private syncRelay(): void {
    if (this.relay || this.relayTerminated) return;
    // Connect whenever the account is signed in — not only when a routine wants
    // `relay` delivery — so the "Privateer Local Harbor" terminal is always reachable
    // from the app for management (including creating the very first routine).
    if (!hasCredentials()) return;
    this.relay = new RelayClient(
      {
        onPrompt: () => {},
        onInterrupt: () => {},
        // A workflow human_gate / script-approval is surfaced as a select_request; the app
        // answers with select_response (option name) or an approval_response (allow/deny).
        // Both resolve the pending gate — otherwise the harbor relay ignores approvals.
        onApprovalResponse: (id, decision) => this.resolveGate(id, decision === "deny" ? "deny" : "approve"),
        onSelectResponse: (id, value) => this.resolveGate(id, value),
        onControllerAttached: () => this.onControllerAttached(),
        onAttachment: () => {},
        // Routine management from the app. Each MUTATION is account-signed (H2) — a
        // forged routine would run a headless bypass-mode session (RCE) — so it's
        // verified (authorizeControl, fail-closed) before routinesControl validates +
        // persists + re-pushes the list with a one-line result. `list` is read-only.
        onRoutinesList: () => this.pushRoutines(),
        onRoutinesSave: (draft, sig, ts) => this.pushRoutines(this.guardControl("routines_save", { routine: draft }, sig, ts, () => this.routines.save(draft).message)),
        onRoutinesDelete: (idOrName, sig, ts) => this.pushRoutines(this.guardControl("routines_delete", { idOrName }, sig, ts, () => this.routines.remove(idOrName).message)),
        onRoutinesSetEnabled: (idOrName, enabled, sig, ts) => this.pushRoutines(this.guardControl("routines_set_enabled", { idOrName, enabled }, sig, ts, () => this.routines.setEnabled(idOrName, enabled).message)),
        onRoutinesRun: (idOrName, sig, ts) => this.pushRoutines(this.guardControl("routines_run", { idOrName }, sig, ts, () => this.routines.run(idOrName).message)),
        // Ad-hoc task spawns from the app. A forged task_submit/task_spawn runs an
        // arbitrary headless session (RCE) — same blast radius as routines_run — so both
        // are account-signed and verified here (guardControl, fail-closed) BEFORE any
        // session starts. The canonical signed args come from taskControlArgs (undefined
        // → null), matching the app's signer.
        onTaskSubmit: (spec, sig, ts) => {
          const msg = this.guardControl("task_submit", taskControlArgs(spec), sig, ts, () => {
            void this.runTask(spec);
            return `Task "${deriveTaskTitle(spec)}" accepted — running now; the result will appear in your app.`;
          });
          if (msg) this.relay?.sendNotice(msg);
        },
        onTaskSpawn: (spec, sig, ts) => {
          const msg = this.guardControl("task_spawn", taskControlArgs(spec), sig, ts, () => this.spawnLiveTask(spec));
          if (msg) this.relay?.sendNotice(msg);
        },
        // Channel management from the app. `save` has its own signed verify (it also
        // carries sealed secrets — applyChannelSave); `remove` is account-signed here
        // (H2 — a forged removal is a DoS). Then channelsControl writes config.json and
        // re-pushes the list.
        onChannelsList: () => this.pushChannels(),
        onChannelsSave: (draft, sealedSecrets, sig, ts) => this.pushChannels(this.applyChannelSave(draft, sealedSecrets, sig, ts)),
        onChannelsRemove: (platform, sig, ts) => this.pushChannels(this.guardControl("channels_remove", { platform }, sig, ts, () => this.channels.remove(platform as any).message)),
        // MCP connector management from the app. `save` has its own signed verify (it
        // carries a sealed env box — applyMcpSave); `set_enabled`/`remove` are
        // account-signed here (H2 — a forged toggle arms/disarms a tool surface; a
        // forged removal is a DoS). Then mcpControl writes the shared config + re-pushes.
        onMcpList: () => this.pushMcp(),
        onMcpSave: (draft, sealedSecrets, sig, ts) => this.pushMcp(this.applyMcpSave(draft, sealedSecrets, sig, ts)),
        onMcpSetEnabled: (name, enabled, sig, ts) => this.pushMcp(this.guardControl("mcp_set_enabled", { name, enabled }, sig, ts, () => this.mcp.setEnabled(name, enabled).message)),
        onMcpRemove: (name, sig, ts) => this.pushMcp(this.guardControl("mcp_remove", { name }, sig, ts, () => this.mcp.remove(name).message)),
        // Workflow management from the app. Each MUTATION is account-signed (H2) — a forged
        // workflows_save plants a `script` step that bypasses the permission gate (RCE),
        // and workflows_run executes the graph — so all three are verified (guardControl,
        // fail-closed) before the control acts. workflows_run verifies in STRICT mode (it's
        // effectful, like task_spawn). list/get are read-only.
        onWorkflowsList: () => this.pushWorkflows(),
        onWorkflowsGet: (idOrName) => this.relay?.sendWorkflow(this.workflows.get(idOrName) ?? null),
        onWorkflowsSave: (draft, sig, ts) => this.pushWorkflows(this.guardControl("workflows_save", { workflow: draft }, sig, ts, () => this.workflows.save(draft).message)),
        onWorkflowsRemove: (idOrName, sig, ts) => this.pushWorkflows(this.guardControl("workflows_remove", { idOrName }, sig, ts, () => this.workflows.remove(idOrName).message)),
        onWorkflowsRun: (idOrName, sig, ts) => this.pushWorkflows(this.guardControl("workflows_run", { idOrName }, sig, ts, () => this.workflows.run(idOrName).message)),
        onTerminate: () => {
          this.relayTerminated = true;
          this.controllerAttached = false;
          this.relay?.stop();
          this.relay = undefined;
          log("relay terminated from the app; staying offline until the harbor restarts");
        },
        // The account signed this harbor out server-side (revoked from the app's Linked
        // Devices). Beyond ending remote access (onTerminate), this wipes the machine
        // login: drop the relay and clear credentials, so routines/tasks stop cleanly
        // instead of dead-ending on a 401 each run. Stays idle until you /login on this
        // machine and restart the harbor (the relayTerminated guard, as with onTerminate).
        onRevoked: () => {
          this.relayTerminated = true;
          this.controllerAttached = false;
          this.relay?.stop();
          this.relay = undefined;
          handleServerRevoke();
          log("account signed out from the app (session revoked) — cleared credentials; idle until you run /login on this machine and restart the harbor");
        },
        onStatus: (text) => log(`relay: ${text}`),
        onDisconnected: () => {
          this.controllerAttached = false;
        },
      },
      // The name the app shows for this terminal when it has nothing better (no
      // machine label yet). "Local Harbor" is the product name for the always-on
      // agent on the user's own machine — as opposed to hosted Harbor.
      { termId: routineRelayId(), label: "Privateer Local Harbor" },
    );
    void this.relay.start();
    log("relay connection starting (account signed in — routines terminal reachable from the app)");
  }

  // Push the current routines list to an attached controller (its routines
  // manager). `message` is a one-line result from the last mutation, if any.
  private pushRoutines(message?: string): void {
    this.relay?.sendRoutines({ items: this.routines.list(), message });
  }

  // Push the current channel config to an attached controller (its channels
  // manager). `message` is a one-line result from the last mutation, if any.
  private pushChannels(message?: string): void {
    this.relay?.sendChannels({ items: this.channels.list(), message });
  }

  private pushMcp(message?: string): void {
    this.relay?.sendMcp({ items: this.mcp.list(), message });
  }

  // Verify an account-signed MCP save (H2) that also carries a SEALED env box, then
  // apply it. Same shape as applyChannelSave but routed through the generic signed
  // envelope (action "mcp_save", args {draft, sealedSecrets}) — the action tag stops a
  // signature made for any other frame from being replayed as an MCP save. Fail-closed:
  // an unsigned/forged/stale frame returns the refusal message and NOTHING is written.
  // The sealed box opens to { termId, env?, headers?, bearerToken? } — credentials the
  // relay never sees in the clear. mergeSealedMcpSecrets enforces that those three may
  // arrive NO OTHER WAY: a signature proves authorship, not confidentiality.
  private applyMcpSave(draft: Record<string, unknown>, sealedSecrets?: string, sig?: string, ts?: number): string | undefined {
    const auth = authorizeControl(
      routineRelayId(),
      "mcp_save",
      { draft, sealedSecrets: sealedSecrets ?? null },
      sig,
      ts,
    );
    if (!auth.ok) return auth.message;

    let opened:
      | { termId?: string; env?: Record<string, string>; headers?: Record<string, string>; bearerToken?: string }
      | undefined;
    if (sealedSecrets) {
      try {
        opened = openJsonFromApp(sealedSecrets);
      } catch {
        return "Couldn't decrypt the connector credentials — they may have been sealed to a different terminal.";
      }
      if (opened?.termId !== routineRelayId()) {
        return "These credentials were addressed to a different terminal.";
      }
    }
    const prepared = mergeSealedMcpSecrets(draft, opened);
    if (!prepared.ok) return prepared.message;
    return this.mcp.save(prepared.draft as any).message;
  }

  // Push the current workflow summaries to an attached controller (its workflows
  // manager). `message` is a one-line result from the last mutation, if any.
  private pushWorkflows(message?: string): void {
    this.relay?.sendWorkflows({ items: this.workflows.list(), message });
  }

  // Resolve a pending workflow gate with the app's answer (an option name, "allow"/
  // "deny" mapped to approve/deny, or null when dismissed/timed out). No-op if the id is
  // unknown (a stale/duplicate response), so a late frame can't crash the runner.
  private resolveGate(id: string, value: string | null): void {
    const resolve = this.pendingGates.get(id);
    if (!resolve) return;
    this.pendingGates.delete(id);
    resolve(value);
  }

  // Apply an app channel-save. Defense in depth, all fail-closed:
  //   1. AUTHENTICITY (F7/F8): the whole save is signed with the account key we pinned
  //      at link. Verify it — a hostile relay can't forge a token or inject an admin
  //      because it can't produce this signature. No pin yet ⇒ refuse (re-link needed).
  //   2. FRESHNESS (F9): reject a ts below the last applied — no replay/rollback of an
  //      older signed envelope.
  //   3. CONFIDENTIALITY: open any sealed bot credentials (the server never could) and
  //      re-check the embedded termId (belt-and-suspenders over the signature's binding).
  private applyChannelSave(draft: Record<string, unknown>, sealedSecrets?: string, sig?: string, ts?: number): string | undefined {
    const accountPub = loadAccountSignKey();
    if (!accountPub) return "This terminal can't accept channel changes from the app yet — re-link it to establish trust.";
    if (!sig || typeof ts !== "number") return "Refused an unsigned channel change.";
    // Verify against OUR termId — a signature made for a different terminal won't match,
    // which also subsumes the misroute check.
    if (!verifyChannelSave(accountPub, { termId: routineRelayId(), ts, draft, sealedSecrets }, sig)) {
      return "Couldn't verify this change came from your account.";
    }
    const lastTs = loadLastControlTs(routineRelayId());
    if (ts < lastTs) return "Ignored an out-of-date channel change.";
    saveLastControlTs(routineRelayId(), ts);

    let withSecrets = draft;
    if (sealedSecrets) {
      let opened: { termId?: string; secrets?: Record<string, string> };
      try {
        opened = openJsonFromApp(sealedSecrets);
      } catch {
        return "Couldn't decrypt the credentials — they may have been sealed to a different terminal.";
      }
      if (opened.termId !== routineRelayId()) {
        return "These credentials were addressed to a different terminal.";
      }
      withSecrets = { ...draft, secrets: opened.secrets ?? {} };
    }
    return this.channels.save(withSecrets as any).message;
  }

  // Verify an account-signed mutating control frame (H2) against this harbor's termId,
  // then run the mutation. Fail-closed: an unsigned/forged/stale frame returns the
  // refusal message and the mutation NEVER runs. `routines_*` and `channels_remove`
  // route through here; `channels_save` has its own verify (sealed secrets) above.
  private guardControl(
    action: string,
    args: Record<string, unknown>,
    sig: string | undefined,
    ts: number | undefined,
    run: () => string | undefined,
  ): string | undefined {
    // task_submit/task_spawn are NON-idempotent (each runs a headless session), so they
    // require a strictly-fresh ts — a replayed frame with an equal ts must NOT re-run.
    // The idempotent config mutations (routines/channels save|delete) keep the default
    // at-or-above acceptance. See authorizeControl's strict note.
    const strict = action === "task_submit" || action === "task_spawn" || action === "workflows_run";
    const auth = authorizeControl(routineRelayId(), action, args, sig, ts, { strict });
    if (!auth.ok) return auth.message;
    return run();
  }

  private onControllerAttached(): void {
    this.controllerAttached = true;
    this.markActivity(); // hosted: a driver is present — reset the idle timer

    this.relay?.sendSnapshot([{ kind: "notice", text: "Privateer routines — results will appear here as they run." }]);
    // Version + this terminal's identity public key (so the app can confirm this is
    // the terminal it PINNED at link time before sealing channel tokens to it). No
    // model/cwd — the routines terminal isn't a single-model session, and cwd is PII.
    let terminalPub: string | undefined;
    try { terminalPub = terminalPublicKeyBase64(); } catch { /* no key → app can't seal, falls back */ }
    this.relay?.sendContext({ version: agentVersion(), terminalPub });
    // Prime the app's routines manager so it has the list on open (it also asks
    // explicitly via routines_list; this just avoids a first-frame wait).
    this.pushRoutines();
    // Same for the channels manager.
    this.pushChannels();
    // …and the workflows manager.
    this.pushWorkflows();
    const pending = drainPendingRelay();
    if (pending.length === 0) return;
    log(`controller attached — flushing ${pending.length} pending routine result(s)`);
    for (const p of pending) this.relay?.sendRoutineResult(p.routine, p.content);
  }

  // ── Cloud outbox (sealed store-and-forward) ────────────────────────────────
  // The sealing itself now lives in ../outbox/cloudOutbox.ts — an interactive
  // remote-drive session needs the same path when the app isn't there to receive a
  // finished turn, and two copies of an E2EE wire format is one too many. Same
  // caches, same fail-closed key verification; this is just the harbor's caller.

  private async postOutbox(
    name: string,
    at: string,
    status: "ok" | "error",
    content: string,
    kind: OutboxKind = "routine",
    media: StagedMedia[] = [],
  ): Promise<boolean> {
    return sealToOutbox(name, at, status, content, kind, media);
  }

  private async flushPendingCloud(): Promise<void> {
    if (!hasCredentials()) return;
    const queue = loadPendingCloud();
    if (queue.length === 0) return;
    const remaining: PendingCloud[] = [];
    for (const p of queue) {
      if (
        remaining.length === 0 &&
        (await this.postOutbox(p.routine, p.at, p.status, p.content, p.kind ?? "routine", p.media ?? []))
      ) continue;
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
    await this.hostedTick();
  }

  // ── Harbor hosted mode ──────────────────────────────────────────────────────
  // A hosted harbor runs on-demand: it reports its earliest upcoming fire time so
  // the server can wake it while suspended, and idle-suspends when there's no work.
  // No-op on a user's own machine (isHosted() === false).

  private markActivity(): void { this.lastActivityAt = Date.now(); }

  // Earliest fire time (ms) across enabled, valid routines — mirrors tick()'s fire
  // filters so we never report/wait on a routine the scheduler won't actually fire.
  private earliestFireMs(): number | null {
    let earliest: number | null = null;
    for (const r of loadRoutines()) {
      if (!r.enabled || triggerError(r)) continue;
      const nrStr = r.nextRun ?? computeNextRun(r)?.toISOString();
      if (!nrStr) continue;
      const t = Date.parse(nrStr);
      if (Number.isNaN(t)) continue;
      if (earliest === null || t < earliest) earliest = t;
    }
    return earliest;
  }

  // Report our next fire time to the server so its scheduler can wake us. When
  // `suspending`, also flip the server-side status to suspended (we're about to
  // exit) so the sweeper knows to wake us again. Best-effort: an offline instance
  // retries next tick; a suspend report failing means we stay up this tick.
  private async reportSchedule(suspending = false): Promise<boolean> {
    if (!isHosted() || !hasCredentials()) return true;
    const earliest = this.earliestFireMs();
    try {
      const res = await apiRequest("/api/harbor/agent/schedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          termId: routineRelayId(),
          nextRoutineAt: earliest !== null ? new Date(earliest).toISOString() : null,
          ...(suspending ? { suspended: true } : {}),
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private shouldSuspend(): boolean {
    if (this.running.size > 0 || this.liveTasks.size > 0) return false;
    if (Date.now() - this.lastActivityAt < HOSTED_IDLE_MS) return false;
    const earliest = this.earliestFireMs();
    if (earliest !== null && earliest - Date.now() < HOSTED_SUSPEND_MIN_LEAD_MS) return false;
    return true;
  }

  private async hostedTick(): Promise<void> {
    if (!isHosted()) return;
    if (this.shouldSuspend()) {
      // Tell the server we're suspending (+ our next fire) BEFORE exiting; only
      // then tear down. If the report fails, stay up and try again next tick.
      if (!(await this.reportSchedule(true))) return;
      log("hosted: idle — suspending (server will wake for the next routine)");
      this.stop();
      void revokeLocalSessions().finally(() => process.exit(0));
      return;
    }
    await this.reportSchedule();
  }

  // Execute a routine to completion and deliver the result. The one rewired seam:
  // drive a headless Pi session (auto-approve gate + restricted tool set) instead of
  // the old engine, collecting the text output.
  async runRoutine(routine: Routine): Promise<IpcResponse> {
    if (this.running.has(routine.id)) return { ok: false, message: "already running" };
    this.running.add(routine.id);
    this.markActivity(); // hosted: work in progress — don't idle-suspend under it
    log(`running routine "${routine.name}"`);

    const config = loadHarborConfig();
    const modelSpec = routine.model ?? config.defaultModel;
    if (routine.delivery.includes("email")) {
      log("  note: email delivery is not wired yet (Phase 5) — skipping it");
    }

    // A routine delivering to the app's Inbox can answer with more than prose: an
    // artifact fence the app turns into a Cargo card, and files staged through
    // attach_to_result. Both are wired here rather than in the session builder,
    // because both only make sense when there is an Inbox at the other end — a
    // file- or webhook-only routine gets neither the tool nor the brief.
    const toInbox = routine.delivery.includes("cloud");
    const media = toInbox ? new ResultMedia() : undefined;

    const { out, status, error, notes } = await this.runSession({
      prompt: withBrief(routine.prompt, { inbox: toInbox, canAttach: !!media }),
      cwd: routine.cwd,
      model: modelSpec,
      tools: routine.tools ?? [],
      media,
    });

    const content = formatResult(routine, out, status, error, notes);
    const report = await deliver(routine, content, status, {
      media: media?.list() ?? [],
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

  // Build the Pi services for one unattended run: the auto-approve gate, the account
  // provider, web tools when the agent has them, and the MCP adapter.
  //
  // `directTools` is the ONLY way to make per-tool MCP names exist at all. Without it
  // pi-mcp-adapter exposes every connector through a single proxy tool named "mcp" —
  // one grant, all servers, all tools — which is exactly what a per-routine allow-list
  // is supposed to prevent. The adapter reads it from process.env at extension
  // activation, so the build is serialized (serializeBuild) and the previous value is
  // restored. "__none__" is its sentinel for "register none": an unattended run with
  // no connector selectors gets no direct tools, whatever a shared mcp.json says.
  private buildSessionServices(cwd: string, directTools: string[], media?: ResultMedia): Promise<any> {
    return serializeBuild(async () => {
      const gate: GateController = {
        getMode: () => "bypass",
        setMode: () => {},
        allowlist: [],
        allowedOutsideRoots: [],
        cwd,
        confineToCwd: true,
        async localAsk() {
          return "deny";
        },
      };
      // Every extension this session gets, in the one canonical order — including the MCP
      // adapter (Phase 5), the web/media capability shaping, and the filter that ignores
      // any moat shim an older release left in the shared agent dir (releases up to 0.11
      // installed one per extension; the launcher sweeps them, but a daemon can outlive
      // the launch that would have). See config/moat.ts.
      const moat = await moatResourceOptions({ kind: "harbor-session", gate, resultMedia: media });
      // MCP_DIRECT_TOOLS is read by the adapter when its factory RUNS, inside
      // createAgentSessionServices — so it has to wrap the session creation, not the
      // moatResourceOptions() call that imported it.
      const prevDirect = process.env.MCP_DIRECT_TOOLS;
      process.env.MCP_DIRECT_TOOLS = directTools.length > 0 ? directTools.join(",") : "__none__";
      try {
        return await createAgentSessionServices({
          cwd,
          agentDir: agentDir(),
          resourceLoaderOptions: moat as any,
        });
      } finally {
        if (prevDirect === undefined) delete process.env.MCP_DIRECT_TOOLS;
        else process.env.MCP_DIRECT_TOOLS = prevDirect;
      }
    });
  }

  // Turn a routine's stored tool list into what Pi will actually accept.
  //
  // Builtins pass through builtinToolsFor (explicit list, or the safe read/web set).
  // MCP entries are SELECTORS — "<server>__<tool>" / "<server>__*" — and have to be
  // translated into the adapter's registered names before Pi's exact-match `tools:`
  // Set can grant anything at all. A "<server>__*" needs the adapter's metadata cache
  // to enumerate; when that is cold we warm it (below) and re-resolve once.
  private async resolveRunTools(
    raw: string[],
    cwd: string,
    modelSpec: string,
  ): Promise<{ tools: string[]; directToolsEnv: string[]; notes: string[] }> {
    const split = splitRoutineTools(raw);
    const builtin = builtinToolsFor(split.builtin);
    if (split.mcp.length === 0) return { tools: builtin, directToolsEnv: [], notes: [] };

    let resolved: ResolvedMcpTools = resolveMcpSelection(split.mcp);
    if (resolved.coldServers.length > 0) {
      await this.warmMcpCache(cwd, modelSpec, resolved.coldServers);
      resolved = resolveMcpSelection(split.mcp);
    }

    const notes: string[] = [];
    for (const server of resolved.coldServers) {
      notes.push(
        `Connector "${server}" didn't provide a tool list, so none of its tools were available to this run. ` +
          `Check it is configured and, if it uses OAuth, that it is still authorized.`,
      );
    }
    for (const selector of resolved.unknownTools) {
      notes.push(`Connector tool "${selector}" doesn't exist on that connector, so it was not available to this run.`);
    }
    if (resolved.names.length > 0) {
      log(`  connectors: ${resolved.servers.join(", ")} → ${resolved.names.length} tools`);
    }
    for (const note of notes) log(`  ${note}`);
    return { tools: [...builtin, ...resolved.names], directToolsEnv: resolved.directToolsEnv, notes };
  }

  // Make pi-mcp-adapter build a fresh tool inventory for every configured connector.
  //
  // The adapter only connects to ALL of them when agent/mcp-cache.json is absent
  // (init.ts → bootstrapAll); with the file present it connects lazily, so a connector
  // added since the last session never gets an inventory and a "<server>__*" selector
  // over it expands to nothing, for ever. Dropping the cache is safe — it is a cache —
  // and makes this one throwaway session rebuild it. The session is never prompted
  // (empty allow-list) and its MCP connections close on the adapter's idle timeout.
  //
  // The adapter does NOT await its own initialization from session_start — it stashes
  // the promise and returns — so session creation resolving means nothing here. We
  // watch the cache file instead, and give up after WARM_TIMEOUT_MS: a connector that
  // never answers (dead endpoint, expired OAuth) must not hold a scheduled run open.
  //
  // A warm rebuilds the inventory for EVERY configured connector, so two runs that
  // both hit a cold selector share one pass rather than racing to wipe the file out
  // from under each other.
  private warmMcpCache(cwd: string, modelSpec: string, servers: string[]): Promise<void> {
    if (this.warmInFlight) return this.warmInFlight;
    const p = this.doWarmMcpCache(cwd, modelSpec, servers).finally(() => {
      if (this.warmInFlight === p) this.warmInFlight = undefined;
    });
    this.warmInFlight = p;
    return p;
  }

  private async doWarmMcpCache(cwd: string, modelSpec: string, servers: string[]): Promise<void> {
    log(`  warming connector tool lists: ${servers.join(", ")}`);
    try {
      rmSync(join(agentDir(), "mcp-cache.json"), { force: true });
      const services = await this.buildSessionServices(cwd, []);
      const { provider, modelId } = parseSpec(modelSpec);
      const model = (modelRegistryOf(services) as any).find(provider, modelId);
      if (!model) return;
      const { session } = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(cwd),
        model,
        tools: [],
      } as any);
      try {
        const deadline = Date.now() + WARM_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const inventory = readMcpInventory(agentDir());
          if (servers.every((s) => (inventory[s]?.length ?? 0) > 0)) break;
          await new Promise((r) => setTimeout(r, WARM_POLL_MS));
        }
      } finally {
        session.dispose?.();
      }
    } catch (e) {
      log(`  connector warm-up failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Drive one headless Pi turn to completion and return its collected text + status.
  // The shared core of BOTH a scheduled routine and an app-submitted ad-hoc task: an
  // auto-approve (bypass) gate whose safety is the restricted `tools` list — a dangerous
  // shell command still fail-closes headlessly (localAsk denies) — plus per-run account
  // credentials that are revoked in the finally so they never linger as an orphaned
  // "device" in the app's Linked Devices.
  private async runSession(spec: {
    prompt: string;
    cwd: string;
    model: string;
    tools: string[];
    media?: ResultMedia;
  }): Promise<{ out: string; status: "ok" | "error"; error?: string; notes: string[] }> {
    let out = "";
    let status: "ok" | "error" = "ok";
    let error: string | undefined;
    let spawnedAccount = false;
    const resolved = await this.resolveRunTools(spec.tools, spec.cwd, spec.model);
    // attach_to_result rides with the staging area rather than the allow-list: it is
    // how the answer is DELIVERED, not a capability the run gains. A routine that
    // named an explicit tool list still gets it, because the alternative is a run
    // that can generate a still and then has no way to hand it over — and the file
    // is going to the user's own mailbox, which `delivery: cloud` already chose.
    const allowedTools = spec.media ? [...resolved.tools, ATTACH_RESULT_TOOL] : resolved.tools;
    const { directToolsEnv, notes } = resolved;
    try {
      const services = await this.buildSessionServices(spec.cwd, directToolsEnv, spec.media);

      const { provider, modelId } = parseSpec(spec.model);
      if (provider === "privateer") {
        try {
          const creds = await acquireAccountCredential();
          await persistAccountCredential(creds);
          rememberAccountCredential(creds); // claim it, so the teardown drops OUR entry only
          spawnedAccount = true;
        } catch (e) {
          log(`  account channel unavailable: ${(e as Error).message}`);
        }
      }

      const model = (modelRegistryOf(services) as any).find(provider, modelId);
      if (!model) {
        status = "error";
        error = `model ${provider}/${modelId} not found`;
      } else {
        const { session } = await createAgentSessionFromServices({
          services,
          sessionManager: SessionManager.inMemory(spec.cwd),
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
        await session.prompt(spec.prompt);
      }
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
    } finally {
      // Revoke ONLY this run's account inference session (the harbor's own child API
      // session — relay/outbox — stays alive until shutdown). Drop Pi's persisted copy
      // too so a later run's fallback never reuses a revoked token. Best-effort.
      if (spawnedAccount) {
        try { await revokeAccountSession(); } catch { /* best effort — server TTL is the fallback */ }
        // Ownership-checked: an interactive terminal on this machine shares auth.json,
        // and its entry must survive a harbor run's teardown (see providers/account.ts).
        try { await dropPersistedAccountCredential(); } catch { /* nothing persisted */ }
      }
    }
    return { out, status, error, notes };
  }

  // Run an app-submitted AD-HOC task (task_submit): one restricted headless turn whose
  // result is sealed to the account outbox (durable, server-can't-read) and, if a
  // controller is attached, mirrored live. NOT a stored routine — no schedule, no
  // persistence beyond delivery. The signed-frame gate (guardControl) already ran; this
  // just executes. Concurrency-guarded by a `task:<title>` key in `this.running` (never
  // collides with routine ids, which are uuids).
  async runTask(spec: TaskSpec): Promise<void> {
    const config = loadHarborConfig();
    const cwd = spec.cwd && spec.cwd.trim() ? spec.cwd : process.cwd();
    const modelSpec = spec.model && spec.model.trim() ? spec.model : config.defaultModel;
    const title = deriveTaskTitle(spec);
    const key = `task:${title}`;
    if (this.running.has(key)) {
      this.relay?.sendNotice(`A task titled "${title}" is already running.`);
      return;
    }
    this.running.add(key);
    log(`running task "${title}"`);
    // A submitted task ALWAYS answers into the Inbox, so it always gets the brief and
    // the attachment tool — the app is the only place its result is ever read.
    const media = new ResultMedia();
    try {
      const { out, status, error, notes } = await this.runSession({
        prompt: withBrief(spec.prompt, { inbox: true, canAttach: true }),
        cwd,
        model: modelSpec,
        tools: spec.tools ?? [],
        media,
      });
      const content = redactText(formatTaskResult(title, out, status, error, modelSpec, notes), collectSecrets(config.providers));
      const at = new Date().toISOString();
      const staged = media.list();
      // Durable delivery: seal to the outbox. If we can't seal yet (no verified pubkey /
      // offline), queue it with kind:"task" so the flush re-seals it correctly later.
      const sealed = await this.postOutbox(title, at, status, content, "task", staged);
      if (!sealed) addPendingCloud({ routine: title, at, status, content, kind: "task", ...(staged.length ? { media: staged } : {}) });
      // Live mirror if a controller is attached (the outbox copy is the source of truth).
      if (this.controllerAttached) this.relay?.sendTaskResult(title, content);
      log(`  task "${title}" ${status}; ${sealed ? "sealed to outbox" : "queued for outbox"}`);
    } finally {
      this.running.delete(key);
    }
  }

  // Stand up a live, app-drivable session (task_spawn). Async: the session + its own relay
  // terminal are created in the background, then the app is told the new termId via
  // sendTaskSpawned so it can attach and drive. Returns an immediate ack for the notice.
  // The signed-frame gate (guardControl) already ran before this is called.
  private spawnLiveTask(spec: TaskSpec): string {
    void (async () => {
      try {
        const handle = await createLiveTaskSession(spec, {
          defaultModel: loadHarborConfig().defaultModel,
          parseSpec,
          log,
          onClosed: (id) => this.liveTasks.delete(id),
          // A live spawn's feed lives only in the attached app; when the session ends
          // (closed, reaped, or timed out) its answer would otherwise be gone. Seal the
          // closing one to the outbox like a submitted task's, so the app's inbox holds
          // every agent result, not just the unattended ones. Same queue-on-failure path.
          onResult: ({ title, status, content }) => {
            void (async () => {
              const at = new Date().toISOString();
              const body = redactText(content, collectSecrets(loadHarborConfig().providers));
              if (!(await this.postOutbox(title, at, status, body, "task"))) {
                addPendingCloud({ routine: title, at, status, content: body, kind: "task" });
              }
            })();
          },
        });
        this.liveTasks.set(handle.termId, handle);
        this.relay?.sendTaskSpawned(handle.termId, handle.label);
        log(`live task spawned: ${handle.termId} (${handle.label})`);
      } catch (e) {
        const reason = (e as Error).message;
        const msg = `Couldn't spawn a live session: ${reason}`;
        log(msg);
        // Typed failure reply so the app's spawn screen stops waiting and shows why. Also send
        // a notice as a back-compat fallback for older app builds that don't handle the frame.
        this.relay?.sendTaskSpawnError(reason);
        this.relay?.sendNotice(msg);
      }
    })();
    const title = deriveTaskTitle(spec);
    return `Spawning a live session "${title}" — it'll open in your app in a moment.`;
  }

  // Run a saved workflow graph to completion (workflows_run / the injected runNow). The
  // signed-frame gate (guardControl, STRICT) already ran before this is reached. Wires the
  // runner's injected seams to the harbor's real capabilities: agent steps → runSession
  // (SAFE_TOOLS gate), gates → relay approvals, scripts → a gated child process (only when
  // attended + approved; the runner fail-closes an unattended script itself), and the
  // result is sealed to the outbox + mirrored live, exactly like an ad-hoc task.
  async runWorkflow(wf: Workflow): Promise<void> {
    const key = `wf:${wf.workflow.id}`;
    if (this.running.has(key)) {
      this.relay?.sendNotice(`Workflow "${wf.workflow.name}" is already running.`);
      return;
    }
    this.running.add(key);
    log(`running workflow "${wf.workflow.name}"`);
    try {
      const deps: RunnerDeps = {
        runAgent: (spec) => this.runWorkflowAgent(spec),
        runScript: (step, cwd) => this.runScript(step, cwd),
        askGate: (step, promptText) => this.askGate(step.options.map((o) => ({ name: o.name, description: o.description })), promptText),
        attended: () => this.controllerAttached,
        // Preserve the harbor's one-at-a-time discipline: fan-out (parallel/for_each) runs
        // sequentially here, so a workflow never spawns concurrent headless sessions on the
        // resident harbor. (The standalone runner defaults to 4; a UI host can raise it.)
        concurrency: 1,
        // An effectful step reached while unattended: seal a "needs approval" notice so the
        // user catches up, and (if a controller is somehow attached) surface it live.
        deferForApproval: async (reason) => {
          const at = new Date().toISOString();
          if (!(await this.postOutbox(wf.workflow.name, at, "error", reason, "task"))) {
            addPendingCloud({ routine: wf.workflow.name, at, status: "error", content: reason, kind: "task" });
          }
          this.relay?.sendNotice(reason);
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        log: (m) => log(`  [wf ${wf.workflow.name}] ${m}`),
        // Live progress: announce each step start in the harbor terminal's feed.
        onEvent: (ev) => {
          if (ev.type === "step_start") this.relay?.sendNotice(`▶ ${ev.name}`);
        },
      };

      const result = await executeWorkflow(wf, {}, deps);
      const status: "ok" | "error" = result.status === "success" ? "ok" : "error";
      const content = formatWorkflowResult(wf.workflow.name, result);
      const at = new Date().toISOString();
      // Durable delivery: seal to the outbox (queue on failure to re-seal later).
      if (!(await this.postOutbox(wf.workflow.name, at, status, content, "workflow"))) {
        addPendingCloud({ routine: wf.workflow.name, at, status, content, kind: "workflow" });
      }
      if (this.controllerAttached) this.relay?.sendWorkflowResult(wf.workflow.name, content);
      log(`  workflow "${wf.workflow.name}" ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
      this.pushWorkflows();
    } finally {
      this.running.delete(key);
    }
  }

  // Bridge a workflow human_gate to a relay selection prompt. Returns the chosen option
  // name, or null when there's no controller / the app dismisses it / it times out — the
  // runner treats null as fail-closed (defer the run). Only one gate is outstanding per
  // running workflow (the runner awaits it), so a fresh id per call is sufficient.
  private askGate(options: { name: string; description?: string }[], promptText: string): Promise<string | null> {
    if (!this.controllerAttached || !this.relay) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingGates.delete(id);
        resolve(null);
      }, GATE_TIMEOUT_MS);
      this.pendingGates.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.relay!.requestSelect(id, {
        title: promptText,
        options: options.map((o) => ({ value: o.name, label: o.description || o.name })),
      });
    });
  }

  // Execute a workflow `script` step as a gated child process. The runner ONLY calls this
  // after its fail-closed posture check (attended + approved), so reaching here means the
  // account authorized this exact command. Args are passed as argv (no shell), stdout is
  // parsed as JSON into `output` when it's an object, and the process is hard-killed at its
  // timeout so a hung script can't pin the run.
  private runScript(step: Extract<Step, { type: "script" }>, cwd: string): Promise<ScriptRunResult> {
    return new Promise((resolve) => {
      let out = "";
      let err = "";
      let done = false;
      const finish = (r: ScriptRunResult) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(step.command, step.args, {
          cwd,
          env: { ...process.env, ...(step.env ?? {}) },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        return finish({ output: {}, status: "error", exitCode: -1, error: (e as Error).message });
      }
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        finish({ output: {}, status: "error", exitCode: -1, error: `script timed out after ${step.timeout ?? 120}s` });
      }, (step.timeout ?? 120) * 1000);
      child.stdout?.on("data", (d) => { out += String(d); });
      child.stderr?.on("data", (d) => { err += String(d); });
      child.on("error", (e) => { clearTimeout(timer); finish({ output: {}, status: "error", exitCode: -1, error: e.message }); });
      child.on("close", (code) => {
        clearTimeout(timer);
        let output: Record<string, unknown> = {};
        try { const p = JSON.parse(out.trim()); if (p && typeof p === "object" && !Array.isArray(p)) output = p as Record<string, unknown>; } catch { /* non-JSON stdout → no structured output */ }
        finish({ output, status: code === 0 ? "ok" : "error", exitCode: code ?? -1, error: code === 0 ? undefined : (err.trim().slice(0, 500) || `exited ${code}`) });
      });
    });
  }

  // Drive one workflow `agent` step through the shared headless runSession (SAFE_TOOLS
  // gate), then best-effort parse its stdout as a JSON object into structured `output`
  // (so a later step can route on `{{ step.output.field }}`). Non-JSON output leaves
  // `output` empty and lives in `text` — the raw/display path.
  private async runWorkflowAgent(spec: AgentRunSpec): Promise<AgentRunResult> {
    const config = loadHarborConfig();
    const model = spec.model && spec.model.trim() ? spec.model : config.defaultModel;
    const { out, status, error, notes } = await this.runSession({ prompt: spec.prompt, cwd: spec.cwd, model, tools: spec.tools ?? [] });
    let output: Record<string, unknown> = {};
    try { const p = JSON.parse(out.trim()); if (p && typeof p === "object" && !Array.isArray(p)) output = p as Record<string, unknown>; } catch { /* non-JSON → raw text only */ }
    // A step's `text` is what a later step interpolates and what the run report shows,
    // so an unreachable connector has to be visible there too — silently returning a
    // thinner answer is how a broken graph looks like a working one.
    return { text: notes.length > 0 ? `${out}${formatNotes(notes)}` : out, output, status, error };
  }

  // What the app can actually see. A harbor is only drivable while its relay socket
  // is up, and every way that can fail — signed out, turned off from the app, refused
  // by the plan's agent cap, a socket that died without closing — used to be visible
  // ONLY as a line in a log file nobody reads. Reported alongside pid/uptime so
  // `privateer harbor status` can never again say "running" about a harbor the app
  // shows as offline.
  private relayStatus(): RelayStatus {
    const termId = routineRelayId();
    if (this.relayTerminated) {
      return { termId, connected: false, detail: "remote access was turned off from the app — restart the harbor to re-enable it" };
    }
    if (!this.relay) {
      return {
        termId,
        connected: false,
        detail: hasCredentials()
          ? "relay not started"
          : "no account signed in on this machine — run `privateer` and /login, then restart the harbor",
      };
    }
    const conn = this.relay.connectionStatus();
    if (!conn.connected) return { termId, connected: false, detail: "connecting…" };
    return { termId, connected: true, upSec: conn.upSec, quietSec: conn.quietSec };
  }

  private persistRun(id: string, patch: Partial<Routine>): void {
    const current = findRoutine(loadRoutines(), id);
    if (!current) return;
    upsertRoutine({ ...current, ...patch });
  }

  private async handleIpc(req: IpcRequest): Promise<IpcResponse> {
    switch (req.cmd) {
      case "status":
        return {
          ok: true,
          pid: process.pid,
          uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
          relay: this.relayStatus(),
          routines: loadRoutines(),
        };
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

// Entry point for `privateer harbor`. Caller must have imported ./boot.ts first.
export function runHarbor(): void {
  const harbor = new Harbor();
  const shutdown = () => {
    log("shutting down");
    harbor.stop();
    void revokeLocalSessions().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  harbor.start().catch(async (err) => {
    if (err instanceof HarborAlreadyRunningError) {
      // A resident harbor already owns this machine — leave it in charge. Exit 0 so a
      // manual `privateer harbor run` beside the installed login service isn't an error.
      //
      // Say WHICH harbor, and whether it is actually reachable from the app: the
      // incumbent can be a stale process that still answers IPC while its relay socket
      // is long dead, and "leaving the existing one in charge" then reads as reassurance
      // for a harbor the app shows as offline. The incumbent knows — ask it.
      process.stderr.write("A Harbor is already running on this machine — leaving the existing one in charge.\n");
      try {
        const status = await sendToHarbor({ cmd: "status" }, 3_000);
        const up = typeof status.uptimeSec === "number" ? `, up ${formatDuration(status.uptimeSec)}` : "";
        process.stderr.write(`  incumbent: pid ${status.pid ?? "?"}${up}\n`);
        process.stderr.write(`  relay:     ${describeRelay(status.relay)}\n`);
        if (status.relay && !status.relay.connected) {
          process.stderr.write("  Stop that process (or `privateer harbor uninstall && privateer harbor install`) to hand the machine to a fresh Harbor.\n");
        }
      } catch {
        // It held the lock a moment ago but won't answer now — a wedged process is
        // worth naming too, since nothing else will start while it holds the socket.
        process.stderr.write("  incumbent: holds the lock but is not answering IPC — it may be wedged; stop it and start again.\n");
      }
      process.exit(0);
    }
    process.stderr.write(`Harbor failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
