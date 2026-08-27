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
import type { CargoSaveRequest, CargoSaveResult } from "./cargoSave.ts";
import type { LibrarySaveRequest, LibrarySaveResult } from "./librarySave.ts";
import type { ChartOpRequest, ChartOpResult } from "./chartOps.ts";

// How much of a driven turn's reply we hold for possible outbox delivery. The
// sealed item is capped at 45k plaintext anyway; this just stops a pathological
// turn from growing the buffer without bound.
const MAX_TURN_CAPTURE = 60_000;

// How long the app gets to encrypt an artifact and store it before the save_cargo tool
// gives up. Generous because the app end is a real round trip — encrypt, POST /api/cargo,
// wait on the network — and a phone on a slow link is the normal case, not the edge one.
// Read per call rather than at module load so a test can set it without re-importing the
// module (and so the env is read in the process that actually runs the save).
const cargoSaveTimeoutMs = (): number => Number(process.env.PRIVATEER_CARGO_TIMEOUT_MS) || 60_000;

// How long the app gets to answer a chart op. Same generosity and the same reasoning as
// the cargo deadline — a create fans out into one POST per card, each encrypted on the
// device first, so a chart of a dozen cards over a phone link is several seconds of real
// work, not a round trip.
const chartOpTimeoutMs = (): number => Number(process.env.PRIVATEER_CHART_TIMEOUT_MS) || 60_000;

// How long the app gets to file a Library save. Longer than the two above, and the
// difference is real work rather than slack: those move a document and a few cards,
// this moves up to 25 MB across the relay and then puts it through an encrypt and an
// S3 upload on the other side. A phone on a mobile connection can spend a minute on
// that legitimately, and timing out on a save that then succeeds is the worst
// outcome — the model tells the user it failed while the file is in their library.
const librarySaveTimeoutMs = (): number => Number(process.env.PRIVATEER_LIBRARY_TIMEOUT_MS) || 180_000;

// The outbound surface the bridge needs; RelayClient implements all of it.
export interface RelayLike {
  requestApproval(id: string, req: PermissionRequest): void;
  sendEvent(ev: EngineEvent): void;
  isConnected(): boolean;
  // Is a controller actually attached (not merely "our socket is up")? Optional:
  // a relay that can't tell is treated as attached, so an unknown audience never
  // turns into a duplicate of something the app already displayed.
  hasController?(): boolean;
  sendNoQuarter(on: boolean): void;
  sendFile(file: { name: string; mediaType: string; base64: string; size: number }): Promise<{ ok: boolean; reason?: string }>;
  sendNotice(text: string): void;
  sendCommands(commands: { name: string; description?: string }[]): void;
  requestSelect(id: string, req: SelectRequest): void;
  requestInput(id: string, req: InputRequest): void;
  sendFileMatches(id: string, matches: { path: string; isDir: boolean }[]): void;
  sendExtensions(payload: ExtensionsPayload): void;
  sendSkills(payload: SkillsPayload): void;
  requestCargoSave(id: string, req: CargoSaveRequest): void;
  requestChartOp(id: string, req: ChartOpRequest): void;
  // Async, unlike its two siblings: a multi-megabyte send yields between frames so it
  // can't starve the event loop, so the transport has a promise to hand back.
  requestLibrarySave(id: string, req: LibrarySaveRequest): Promise<void>;
}

// The installed-extensions snapshot relayed to the app's extensions manager.
//
// `managed`/`builtIn` describe the moat, which `installed` never contains (it is loaded
// as launch shims, not settings "packages"). Callers do NOT set them: each transport
// stamps them on the way out — RelayClient.sendExtensions from the shipping manifest,
// IpcRelay from reservedNames() — because a constant of the build passed by hand at six
// call sites is the drift moatManifest.json exists to make unrepresentable. Declared
// here only so a transport can type what it adds.
export interface ExtensionsPayload {
  installed: { source: string; scope: string; filtered?: boolean; installed?: boolean }[];
  builtIn?: { name: string; note?: string }[];
  managed?: string[];
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
  // Exactly one of these. `base64` is the cloud relay's shape: the app is on another
  // machine, so the bytes are chunked across. `path` is the desktop's: app and agent
  // share a disk (IpcRelay), so the file is named rather than moved — which is why a
  // desktop attachment has no size cap. Both are consumed by AttachmentStore.register.
  base64?: string;
  path?: string;
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
  // The last controller went away. Informational for the owner (the bridge already
  // fails pending approvals closed); a driven turn in flight keeps running.
  onControllerDetached?: () => void;
  // A driven turn finished with NOBODY on the other end — the app was closed, killed,
  // or its socket was reaped while the agent worked. Everything the turn streamed up
  // was dropped by the relay, so the owner should deliver this durably instead (seal
  // it to the account outbox → the app's Inbox). Called once per unwatched turn, after
  // the turn settles; `prompt` is what was asked, `content` the reply as streamed.
  onUnwatchedResult?: (result: { prompt: string; content: string }) => void;
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
  private readonly pendingCargo = new Map<string, (r: CargoSaveResult) => void>();
  private readonly pendingCharts = new Map<string, (r: ChartOpResult) => void>();
  private readonly pendingLibrary = new Map<string, (r: LibrarySaveResult) => void>();
  private pendingAttachments: RemoteAttachment[] = [];
  // The driven turn in flight, kept only so it can be delivered to the outbox if it
  // turns out nobody was watching (see settleTurn). Bounded: the outbox truncates at
  // 45k anyway, and this must not grow with a runaway turn.
  //
  // `turnDriven` is deliberately NOT `remote`: a mid-turn disconnect clears `remote`
  // (so the gate stops waiting on a controller that's gone) and that is exactly the
  // case this feature exists for — the turn was still driven by the app, and its
  // answer still has to reach the account. Only settleTurn clears it.
  private turnDriven = false;
  private turnPrompt = "";
  private turnText = "";

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
      this.turnDriven = true;
      this.turnPrompt = text;
      this.turnText = "";
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
    // Routines are owned by the harbor, not an interactive session, so its own relay
    // (not this bridge) handles routines_*. These no-ops just satisfy Required — an
    // interactive terminal never surfaces the routines manager in the app.
    onRoutinesList: () => {},
    onRoutinesSave: () => {},
    onRoutinesDelete: () => {},
    onRoutinesSetEnabled: () => {},
    onRoutinesRun: () => {},
    // Ad-hoc task spawns are harbor-owned too (they run on / are stood up by the harbor,
    // not an interactive session), so its own relay handles task_submit/task_spawn. These
    // no-ops just satisfy Required — an interactive terminal never receives them.
    onTaskSubmit: () => {},
    onTaskSpawn: () => {},
    // Channels, like routines, are owned by the harbor (its channels/run.ts config),
    // not an interactive session — the harbor's own relay handles channels_*. These
    // no-ops just satisfy Required; an interactive terminal never surfaces channels.
    onChannelsList: () => {},
    onChannelsSave: () => {},
    onChannelsRemove: () => {},
    // MCP connectors, like channels, are managed on the harbor (the host that runs the
    // adapter) — the harbor's own relay handles mcp_*. These no-ops just satisfy Required;
    // an interactive terminal manages MCP over IPC (desktop), never over this relay.
    onMcpList: () => {},
    onMcpSave: () => {},
    onMcpSetEnabled: () => {},
    onMcpRemove: () => {},
    // Workflows, like routines/channels, are harbor-owned — the harbor's own relay handles
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
    onCargoSaved: (id, result) => {
      const resolve = this.pendingCargo.get(id);
      if (resolve) resolve(result);
    },
    onLibrarySaved: (id, result) => {
      const resolve = this.pendingLibrary.get(id);
      if (resolve) resolve(result);
    },
    onChartResult: (id, result) => {
      const resolve = this.pendingCharts.get(id);
      if (resolve) resolve(result);
    },
    onFilesSearch: (id, query) => this.cfg.onFilesSearch?.(id, query),
    onNoQuarter: (on) => {
      this.noQuarter = on;
      this.relay?.sendNoQuarter(on); // echo the ack back so the app's toggle syncs
    },
    onControllerAttached: () => this.cfg.onControllerAttached?.(),
    // The app left while we're still running. Same posture as a dropped socket: stop
    // treating the turn as remote (the gate must not wait on a controller that isn't
    // there) and fail every pending approval closed. The turn itself keeps going —
    // and settleTurn will deliver its answer to the outbox, since `turnDriven` (unlike
    // `remote`) survives the departure.
    onControllerDetached: () => {
      this.remote = false;
      this.rejectAllPending();
      this.cfg.onControllerDetached?.();
    },
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
  //
  // Also the one moment we can tell whether the turn had an audience. If the app
  // drove it and is now gone, everything the turn streamed up was dropped by the
  // relay — so hand the answer to the owner for durable delivery rather than letting
  // a completed piece of work evaporate because someone closed their phone.
  settleTurn(): void {
    const driven = this.turnDriven;
    const prompt = this.turnPrompt;
    const content = this.turnText.trim();
    this.remote = false;
    this.turnDriven = false;
    this.turnPrompt = "";
    this.turnText = "";
    if (!driven || !content) return;
    // Unknown (a relay that can't report presence) counts as watched: better to skip
    // delivery than to duplicate something the app already showed in its feed.
    const watched = this.relay?.hasController ? this.relay.hasController() : !!this.relay?.isConnected();
    if (watched) return;
    this.cfg.onUnwatchedResult?.({ prompt, content });
  }

  // Forward an EngineEvent up to the app. Safe to call for every event of every
  // turn (local included) — the relay only sends when a socket is open.
  forwardEvent(ev: EngineEvent): void {
    // Keep the driven turn's reply as it streams, in case settleTurn finds nobody
    // was there to read it. Text only: the outbox item is the answer, not a
    // transcript of every tool call.
    if (this.turnDriven && ev.type === "text" && this.turnText.length < MAX_TURN_CAPTURE) {
      this.turnText += String(ev.text ?? "");
    }
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

  // Hand an artifact to the app to encrypt and store as Cargo (the save_cargo tool),
  // and wait for its verdict. The app owns the master key; this process never has one,
  // so this round trip IS the feature rather than a convenience — see cargoSave.ts.
  //
  // Three ways this ends without a stored artifact, each with its own message, because
  // the model gets the reason verbatim and they call for different next moves:
  //
  //  - No controller. Unlike sendFile, "handed to an open socket" is not good enough
  //    here: the caller is promised an artifact id, and with nobody attached the server
  //    drops the frames and we would wait out the full timeout to learn it. hasController()
  //    is checked up front so the failure is immediate and says what to do about it.
  //  - The app answered a refusal (locked vault, storage full, guest session). Passed
  //    through as written — those messages already exist for a person to read.
  //  - Nothing came back inside the deadline. Nothing else wraps this in a timeout the
  //    way the gate wraps remoteAsk, so a silent or too-old app would wedge the turn
  //    forever without one.
  saveCargoRemote = (req: CargoSaveRequest, signal?: AbortSignal): Promise<CargoSaveResult> => {
    if (!this.relay) return Promise.resolve({ ok: false, reason: "remote access is not enabled — run /remote-access on and drive this terminal from the Privateer app" });
    if (!this.relay.isConnected()) return Promise.resolve({ ok: false, reason: "the relay is not connected" });
    // hasController is optional on RelayLike; a transport that can't tell is treated as
    // attached, matching how the rest of the bridge reads it.
    if (this.relay.hasController && !this.relay.hasController()) {
      return Promise.resolve({ ok: false, reason: "the Privateer app is not attached to this terminal — only the app holds the key that encrypts an artifact, so open it and attach before saving" });
    }
    const id = randomUUID();
    return new Promise<CargoSaveResult>((resolve) => {
      const settle = (r: CargoSaveResult) => {
        if (!this.pendingCargo.has(id)) return; // already settled (abort raced the reply)
        this.pendingCargo.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = () => settle({ ok: false, reason: "the turn was interrupted before the app confirmed the save" });
      const deadline = cargoSaveTimeoutMs();
      const timer = setTimeout(
        () => settle({ ok: false, reason: `the app did not answer within ${Math.round(deadline / 1000)}s — it may be an older version that cannot save artifacts from a terminal` }),
        deadline,
      );
      // Don't hold the process open on this timer alone; an exiting CLI shouldn't
      // linger for a save the app is never going to answer.
      timer.unref?.();
      this.pendingCargo.set(id, settle);
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.relay!.requestCargoSave(id, req);
    });
  };

  // Hand a file to the app to classify, encrypt and file in the user's Library (the
  // save_to_library tool), and wait for its verdict. Structurally the twin of
  // saveCargoRemote — the app owns the master key, so this process cannot file
  // anything itself — with two differences worth stating, because both change what a
  // failure means:
  //
  //  - The send is AWAITED. requestLibrarySave yields between frames so a 25 MB
  //    transfer can't starve the event loop, so unlike the cargo path the frames are
  //    not all on the wire by the time we start waiting. A send that throws (the
  //    socket died mid-transfer) settles as a refusal rather than leaving the tool
  //    waiting out the full deadline for an answer to a message that never arrived.
  //  - The deadline is longer (see librarySaveTimeoutMs). Timing out early here is
  //    the expensive mistake: the app may still be uploading, and the model would
  //    tell the user their file didn't save while it lands in their library.
  saveToLibraryRemote = (req: LibrarySaveRequest, signal?: AbortSignal): Promise<LibrarySaveResult> => {
    if (!this.relay) return Promise.resolve({ ok: false, reason: "remote access is not enabled — run /remote-access on and drive this terminal from the Privateer app" });
    if (!this.relay.isConnected()) return Promise.resolve({ ok: false, reason: "the relay is not connected" });
    if (this.relay.hasController && !this.relay.hasController()) {
      return Promise.resolve({ ok: false, reason: "the Privateer app is not attached to this terminal — only the app holds the key that encrypts a file, so open it and attach before saving" });
    }
    const id = randomUUID();
    return new Promise<LibrarySaveResult>((resolve) => {
      const settle = (r: LibrarySaveResult) => {
        if (!this.pendingLibrary.has(id)) return; // already settled (abort raced the reply)
        this.pendingLibrary.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = () => settle({ ok: false, reason: "the turn was interrupted before the app confirmed the save" });
      const deadline = librarySaveTimeoutMs();
      const timer = setTimeout(
        () => settle({ ok: false, reason: `the app did not answer within ${Math.round(deadline / 1000)}s — it may be an older version that cannot save files from a terminal, or the upload is still running` }),
        deadline,
      );
      timer.unref?.();
      this.pendingLibrary.set(id, settle);
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      void this.relay!.requestLibrarySave(id, req).catch((e) =>
        settle({ ok: false, reason: `the transfer failed before the app could file it: ${(e as Error)?.message || "connection lost"}` }),
      );
    });
  };

  // Run a chart operation on the app and wait for its answer. Structurally the twin of
  // saveCargoRemote — the app owns the master key, so reading a card and writing one are
  // both round trips — with one difference worth stating: this is the only place the CLI
  // asks the app for the user's stored CONTENT back. A refusal here has to be as legible
  // as a write failure, because "read the chart first, then add to it" is the normal
  // shape of the work and the model has to be able to act on why it couldn't.
  chartOpRemote = (req: ChartOpRequest, signal?: AbortSignal): Promise<ChartOpResult> => {
    if (!this.relay) return Promise.resolve({ ok: false, reason: "remote access is not enabled — run /remote-access on and drive this terminal from the Privateer app" });
    if (!this.relay.isConnected()) return Promise.resolve({ ok: false, reason: "the relay is not connected" });
    if (this.relay.hasController && !this.relay.hasController()) {
      return Promise.resolve({ ok: false, reason: "the Privateer app is not attached to this terminal — only the app holds the key that opens a chart, so open it and attach first" });
    }
    const id = randomUUID();
    return new Promise<ChartOpResult>((resolve) => {
      const settle = (r: ChartOpResult) => {
        if (!this.pendingCharts.has(id)) return; // already settled (abort raced the reply)
        this.pendingCharts.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = () => settle({ ok: false, reason: "the turn was interrupted before the app answered" });
      const deadline = chartOpTimeoutMs();
      const timer = setTimeout(
        () => settle({ ok: false, reason: `the app did not answer within ${Math.round(deadline / 1000)}s — it may be an older version that cannot work with charts from a terminal` }),
        deadline,
      );
      timer.unref?.();
      this.pendingCharts.set(id, settle);
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.relay!.requestChartOp(id, req);
    });
  };

  private rejectAllPending(): void {
    for (const resolve of this.pending.values()) resolve("deny");
    this.pending.clear();
    // A relayed selection prompt whose controller vanished resolves to "no choice".
    for (const resolve of this.pendingSelects.values()) resolve(null);
    this.pendingSelects.clear();
    // Same for a relayed text prompt: a gone controller resolves to "no input".
    for (const resolve of this.pendingInputs.values()) resolve(null);
    this.pendingInputs.clear();
    // A save whose controller vanished mid-flight is NOT reported as failed-and-done:
    // the app may have encrypted and stored the artifact before its socket dropped, and
    // the frame carrying the id is what we lost. Saying "it didn't save" would send the
    // model round again and leave the user with two copies of the same artifact, so the
    // reason says plainly that the outcome is unknown and names Cargo as the place to
    // look before retrying.
    for (const resolve of this.pendingCargo.values()) {
      resolve({ ok: false, reason: "the app disconnected before confirming the save — it may or may not have stored the artifact; check Cargo in the app before saving again" });
    }
    this.pendingCargo.clear();
    // A chart op whose controller vanished mid-flight gets the same honest "unknown"
    // wording as a cargo save, and for a sharper reason: `edit` applies its steps in
    // order, so a socket that died halfway leaves a chart that is PARTLY changed. Telling
    // the model it failed invites a retry that re-adds every card it already wrote. The
    // only safe next move is to look, so the reason says exactly that.
    for (const resolve of this.pendingCharts.values()) {
      resolve({ ok: false, reason: "the app disconnected before answering — some of the change may already have been applied; open the chart in the app to see what landed before trying again" });
    }
    this.pendingCharts.clear();
    // A Library save whose controller vanished mid-flight gets the same honest
    // "unknown" wording as a cargo save, and the stakes are the same shape: the app
    // may have encrypted and filed the file before its socket dropped. Telling the
    // model it failed invites a retry that leaves the user with the same picture in
    // their library twice, under the same name, with no way to tell which is which.
    for (const resolve of this.pendingLibrary.values()) {
      resolve({ ok: false, reason: "the app disconnected before confirming the save — it may or may not have filed the file; check the library in the app before saving again" });
    }
    this.pendingLibrary.clear();
  }
}
