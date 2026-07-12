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
}

// A CLI-initiated selection prompt relayed to the app (e.g. pick a model).
export interface SelectRequest {
  title: string;
  options: { value: string; label: string; hint?: string }[];
  current?: string;
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
  // A slash command arrived from the app composer (e.g. "/model provider/id").
  // Route it to the same command dispatcher the local REPL uses.
  onCommand?: (text: string) => void;
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
    onCommand: (text) => this.cfg.onCommand?.(text),
    onApprovalResponse: (id, decision) => {
      const resolve = this.pending.get(id);
      if (resolve) resolve(decision);
    },
    onSelectResponse: (id, value) => {
      const resolve = this.pendingSelects.get(id);
      if (resolve) resolve(value);
    },
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
  }
}
