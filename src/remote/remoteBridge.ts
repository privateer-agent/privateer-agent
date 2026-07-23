// The wiring between the relay and the rest of the agent — NEW code for the Pi
// rewrite. It connects three things that were built to meet here:
//   - the Phase-1 adapter's EngineEvents  → up to the app (relay.sendEvent)
//   - the Phase-2 gate's remote branch    → each tool relayed to the app for
//     allow/deny via `remoteAsk` + `getRemote` (the slots makePermissionGate stubbed)
//   - the app's prompts/interrupts        → down into the turn loop (cfg callbacks)
//
// The RelayClient itself is KEEP (verbatim 0.2); this bridge is the only new part,
// so it's what the tests exercise (against a fake relay). Fail-closed throughout:
// no controller, a disconnect, or an aborted turn all resolve a pending approval
// to "deny".

import { randomUUID } from "node:crypto";
import type { EngineEvent } from "../engine/events.ts";
import type { PermissionRequest } from "../permissions/gate.ts";
import type { AskOutcome } from "../permissions/modeGate.ts";
import type { RelayCallbacks } from "./relayClient.ts";

// The outbound surface the bridge needs; RelayClient implements all of it.
export interface RelayLike {
  requestApproval(id: string, req: PermissionRequest): void;
  sendEvent(ev: EngineEvent): void;
  isConnected(): boolean;
  sendNoQuarter(on: boolean): void;
  sendFile(file: { name: string; mediaType: string; base64: string; size: number }): Promise<{ ok: boolean; reason?: string }>;
  sendNotice(text: string): void;
  sendCommands(commands: { name: string; description?: string }[]): void;
  requestSelect(id: string, req: SelectRequest): void;
  requestInput(id: string, req: InputRequest): void;
  sendFileMatches(id: string, matches: { path: string; isDir: boolean }[]): void;
  sendExtensions(payload: ExtensionsPayload): void;
  sendSkills(payload: SkillsPayload): void;
}

// The installed-extensions snapshot relayed to the app's extensions manager.
export interface ExtensionsPayload {
  installed: { source: string; scope: string; filtered?: boolean; installed?: boolean }[];
  busy?: boolean;
  message?: string;
  needsRestart?: boolean;
}

// The skills snapshot relayed to the app's skills manager.
export interface SkillsPayload {
  items: { name: string; description: string; source: string; editable: boolean; disabled: boolean }[];
  busy?: boolean;
  message?: string;
  needsRestart?: boolean;
}

// A CLI-initiated selection prompt relayed to the app (e.g. pick a model).
export interface SelectRequest {
  title: string;
  options: { value: string; label: string; hint?: string }[];
  current?: string;
}

// A CLI-initiated free-form text prompt relayed to the app (e.g. a skill asking
// for a value that isn't a fixed choice).
export interface InputRequest {
  title: string;
  placeholder?: string;
}

export interface RemoteAttachment {
  name: string;
  mediaType: string;
  base64: string;
}

export interface RemoteBridgeConfig {
  // A prompt arrived from the app — drive the turn loop (tagged remote). Any files
  // the app sent ahead of the prompt ride along.
  onPrompt: (text: string, attachments: RemoteAttachment[]) => void;
  onInterrupt?: () => void;
  onTerminate?: () => void;
  // The account signed this terminal out server-side (revoked from the app). The
  // owner should tear down the login and stop the relay — see RelayCallbacks.onRevoked.
  onRevoked?: () => void;
  // A slash command arrived from the app composer (e.g. "/model provider/id").
  // Route it to the same command dispatcher the local REPL uses.
  onCommand?: (text: string) => void;
  // The app's extensions manager opened — the owner should push the installed list.
  onExtensionsList?: () => void;
  // The app asked to install / remove a Pi extension by source spec. `sig`+`ts`
  // authenticate the mutation with the account key (H2) — installing a package is code
  // execution, so the owner verifies before acting (authorizeControl).
  onExtensionsAdd?: (source: string, sig?: string, ts?: number) => void;
  onExtensionsRemove?: (source: string, sig?: string, ts?: number) => void;
  // The app's skills manager opened — the owner should push the skills list.
  onSkillsList?: () => void;
  // The app asked to create/overwrite, delete, or toggle a user skill. Signed (H2) —
  // a skill is an auto-invoked system-prompt instruction, so mutations are verified.
  onSkillCreate?: (skill: { name: string; description: string; instructions: string }, sig?: string, ts?: number) => void;
  onSkillDelete?: (name: string, sig?: string, ts?: number) => void;
  onSkillSetEnabled?: (name: string, enabled: boolean, sig?: string, ts?: number) => void;
  // The app is autocompleting an `@file` mention in its composer — the owner should
  // list the cwd files matching `query` and reply via sendFileMatches(id, …).
  onFilesSearch?: (id: string, query: string) => void;
  // A controller (re)attached — the owner should push a transcript snapshot.
  onControllerAttached?: () => void;
  onStatus?: (text: string) => void;
  // A file finished transferring down from the app. The owner registers it (e.g. into
  // an AttachmentStore) so the save_attachment tool can persist it.
  onAttachment?: (file: RemoteAttachment) => void;
}

export class RemoteBridge {
  private relay?: RelayLike;
  private remote = false;
  private noQuarter = false;
  private readonly pending = new Map<string, (d: AskOutcome) => void>();
  private readonly pendingSelects = new Map<string, (v: string | null) => void>();
  private readonly pendingInputs = new Map<string, (v: string | null) => void>();
  private pendingAttachments: RemoteAttachment[] = [];

  constructor(private readonly cfg: RemoteBridgeConfig) {}

  // Wire the outbound relay once it's constructed (RelayClient needs `callbacks`
  // at construction, so the relay is attached right after).
  attachRelay(relay: RelayLike): void {
    this.relay = relay;
  }

  // Hand this to `new RelayClient(bridge.callbacks)`. Typed Required so every hook
  // (including the ones RelayCallbacks marks optional) is defined — the bridge wires
  // them all.
  readonly callbacks: Required<RelayCallbacks> = {
    onPrompt: (text) => {
      this.remote = true; // a remote turn is now in flight → gate relays each action
      const attachments = this.pendingAttachments;
      this.pendingAttachments = [];
      this.cfg.onPrompt(text, attachments);
    },
    onInterrupt: () => this.cfg.onInterrupt?.(),
    onTerminate: () => this.cfg.onTerminate?.(),
    onRevoked: () => this.cfg.onRevoked?.(),
    onCommand: (text) => this.cfg.onCommand?.(text),
    onExtensionsList: () => this.cfg.onExtensionsList?.(),
    onExtensionsAdd: (source, sig, ts) => this.cfg.onExtensionsAdd?.(source, sig, ts),
    onExtensionsRemove: (source, sig, ts) => this.cfg.onExtensionsRemove?.(source, sig, ts),
    onSkillsList: () => this.cfg.onSkillsList?.(),
    onSkillCreate: (skill, sig, ts) => this.cfg.onSkillCreate?.(skill, sig, ts),
    onSkillDelete: (name, sig, ts) => this.cfg.onSkillDelete?.(name, sig, ts),
    onSkillSetEnabled: (name, enabled, sig, ts) => this.cfg.onSkillSetEnabled?.(name, enabled, sig, ts),
    // Routines are owned by the daemon, not an interactive session, so its own relay
    // (not this bridge) handles routines_*. These no-ops just satisfy Required — an
    // interactive terminal never surfaces the routines manager in the app.
    onRoutinesList: () => {},
    onRoutinesSave: () => {},
    onRoutinesDelete: () => {},
    onRoutinesSetEnabled: () => {},
    onRoutinesRun: () => {},
    // Ad-hoc task spawns are daemon-owned too (they run on / are stood up by the daemon,
    // not an interactive session), so its own relay handles task_submit/task_spawn. These
    // no-ops just satisfy Required — an interactive terminal never receives them.
    onTaskSubmit: () => {},
    onTaskSpawn: () => {},
    // Channels, like routines, are owned by the daemon (its channels/run.ts config),
    // not an interactive session — the daemon's own relay handles channels_*. These
    // no-ops just satisfy Required; an interactive terminal never surfaces channels.
    onChannelsList: () => {},
    onChannelsSave: () => {},
    onChannelsRemove: () => {},
    // MCP connectors, like channels, are managed on the daemon (the host that runs the
    // adapter) — the daemon's own relay handles mcp_*. These no-ops just satisfy Required;
    // an interactive terminal manages MCP over IPC (desktop), never over this relay.
    onMcpList: () => {},
    onMcpSave: () => {},
    onMcpSetEnabled: () => {},
    onMcpRemove: () => {},
    // Workflows, like routines/channels, are daemon-owned — the daemon's own relay handles
    // workflows_*. These no-ops just satisfy Required; an interactive terminal never
    // surfaces workflows.
    onWorkflowsList: () => {},
    onWorkflowsGet: () => {},
    onWorkflowsSave: () => {},
    onWorkflowsRemove: () => {},
    onWorkflowsRun: () => {},
    onApprovalResponse: (id, decision) => {
      const resolve = this.pending.get(id);
      if (resolve) resolve(decision);
    },
    onSelectResponse: (id, value) => {
      const resolve = this.pendingSelects.get(id);
      if (resolve) resolve(value);
    },
    onInputResponse: (id, value) => {
      const resolve = this.pendingInputs.get(id);
      if (resolve) resolve(value);
    },
    onFilesSearch: (id, query) => this.cfg.onFilesSearch?.(id, query),
    onNoQuarter: (on) => {
      this.noQuarter = on;
      this.relay?.sendNoQuarter(on); // echo the ack back so the app's toggle syncs
    },
    onControllerAttached: () => this.cfg.onControllerAttached?.(),
    onAttachment: (file) => {
      this.pendingAttachments.push(file);
      this.cfg.onAttachment?.(file);
    },
    onStatus: (text) => this.cfg.onStatus?.(text),
    onDisconnected: () => {
      this.remote = false;
      // Any approval waiting on a now-gone controller fails closed.
      this.rejectAllPending();
    },
  };

  // ── gate hooks (passed into the GateController) ─────────────────────────────

  getRemote = (): boolean => this.remote;
  getNoQuarter = (): boolean => this.noQuarter;

  // The gate's remote approver: relay the request to the app and await its
  // allow/deny. Fail closed if no controller, on abort, or on disconnect. (The gate
  // also wraps this in its own timeout, so a silent app can't wedge the turn.)
  remoteAsk = (req: PermissionRequest, signal?: AbortSignal): Promise<AskOutcome> => {
    if (!this.relay || !this.relay.isConnected()) return Promise.resolve("deny");
    const id = randomUUID();
    return new Promise<AskOutcome>((resolve) => {
      const onAbort = () => settle("deny");
      const settle = (d: AskOutcome) => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        resolve(d);
      };
      this.pending.set(id, settle);
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.relay!.requestApproval(id, req);
    });
  };

  // Surface a one-line notice in the app's feed (command feedback).
  sendNotice(text: string): void {
    this.relay?.sendNotice(text);
  }

  // Advertise the terminal's available commands to the app (on attach).
  sendCommands(commands: { name: string; description?: string }[]): void {
    this.relay?.sendCommands(commands);
  }

  // Reply to an app `@file` autocomplete query with the matching cwd entries.
  sendFileMatches(id: string, matches: { path: string; isDir: boolean }[]): void {
    this.relay?.sendFileMatches(id, matches);
  }

  // Push the installed-extensions snapshot to the app's extensions manager.
  sendExtensions(payload: ExtensionsPayload): void {
    this.relay?.sendExtensions(payload);
  }

  // Push the skills snapshot to the app's skills manager.
  sendSkills(payload: SkillsPayload): void {
    this.relay?.sendSkills(payload);
  }

  // A CLI-initiated selection prompt: relay the options to the app and await its
  // choice. Fail closed (null) if no controller, on abort, or on disconnect — the
  // same posture as remoteAsk. Callers get the chosen `value` or null.
  selectRemote = (req: SelectRequest, signal?: AbortSignal): Promise<string | null> => {
    if (!this.relay || !this.relay.isConnected()) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise<string | null>((resolve) => {
      const onAbort = () => settle(null);
      const settle = (v: string | null) => {
        this.pendingSelects.delete(id);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
      this.pendingSelects.set(id, settle);
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.relay!.requestSelect(id, req);
    });
  };

  // A CLI-initiated free-form text prompt: relay it to the app and await the typed
  // line. Same fail-closed posture as selectRemote — null if no controller, on
  // abort, or on disconnect. Callers get the submitted string or null.
  inputRemote = (req: InputRequest, signal?: AbortSignal): Promise<string | null> => {
    if (!this.relay || !this.relay.isConnected()) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise<string | null>((resolve) => {
      const onAbort = () => settle(null);
      const settle = (v: string | null) => {
        this.pendingInputs.delete(id);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
      this.pendingInputs.set(id, settle);
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.relay!.requestInput(id, req);
    });
  };

  // ── turn lifecycle + event forwarding ───────────────────────────────────────

  // Mark the end of a turn so the next (possibly local) turn isn't treated as
  // remote. Call after each driven turn completes.
  settleTurn(): void {
    this.remote = false;
  }

  // Forward an EngineEvent up to the app. Safe to call for every event of every
  // turn (local included) — the relay only sends when a socket is open.
  forwardEvent(ev: EngineEvent): void {
    this.relay?.sendEvent(ev);
  }

  // Is a controller actually reachable right now? (Relay socket open.)
  isConnected(): boolean {
    return !!this.relay?.isConnected();
  }

  // Stream a file up to the connected app (the send_file_to_client tool).
  async sendFile(file: { name: string; mediaType: string; base64: string; size: number }): Promise<{ ok: boolean; reason?: string }> {
    if (!this.relay) return { ok: false, reason: "remote access is not enabled" };
    return this.relay.sendFile(file);
  }

  private rejectAllPending(): void {
    for (const resolve of this.pending.values()) resolve("deny");
    this.pending.clear();
    // A relayed selection prompt whose controller vanished resolves to "no choice".
    for (const resolve of this.pendingSelects.values()) resolve(null);
    this.pendingSelects.clear();
    // Same for a relayed text prompt: a gone controller resolves to "no input".
    for (const resolve of this.pendingInputs.values()) resolve(null);
    this.pendingInputs.clear();
  }
}
