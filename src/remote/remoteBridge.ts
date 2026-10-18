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
import { noQuarterActive, setNoQuarter } from "../permissions/noQuarter.ts";
// Pure env-var accessors (see config/privacyDisabled.ts) — no Pi, no node builtins,
// so this stays safe to import from the bridge, which boot-ordered code reaches.
import { onPrivacyDisabledChange, privacyDisabled, setPrivacyDisabled } from "../config/privacyDisabled.ts";
import { emptyUsage, type EngineEvent } from "../engine/events.ts";
import { redactText } from "../util/redact.ts";
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

// How long a question put to the app (a select or a text prompt) outlives the app going
// away. A phone that backgrounds, a tab switch, a socket blip — each detaches the
// controller for a moment, and failing the question there turned an ask_user_question
// into "the user declined" while the user was still reading it. The question is held
// and re-sent on reattach instead; this is only the bound on waiting for someone who
// isn't coming back, so a turn can't sit on a question forever.
const questionGraceMs = (): number => Number(process.env.PRIVATEER_QUESTION_GRACE_MS) || 10 * 60_000;

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
  // Echo the privacy-filter state (off = pi-privacy disabled). Optional so a
  // transport built against an older shape still satisfies the interface; the
  // bridge's callers all treat a missing echo as "filter on", which is the safe read.
  sendPrivacy?(off: boolean): void;
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
  private noQuarter = noQuarterActive();
  private readonly pending = new Map<string, (d: AskOutcome) => void>();
  // Open questions keep their request so a reattaching app can be sent them again.
  private readonly pendingSelects = new Map<string, { resolve: (v: string | null) => void; req: SelectRequest }>();
  private readonly pendingInputs = new Map<string, { resolve: (v: string | null) => void; req: InputRequest }>();
  // Armed while the open questions have no app to answer them (see questionGraceMs).
  private questionGrace?: ReturnType<typeof setTimeout>;
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
  // Did this turn already put finish/aborted/error on the wire? The app lights its
  // working pill the moment it SENDS a prompt and only ever puts it out on one of
  // those three, but Pi's prompt() has paths that never run the agent at all — an
  // extension command or input hook that handles the text, a throw on the
  // no-model / no-key / auth precheck, "compaction in progress". Each returned (or
  // threw into a catch that only printed locally) with no terminal event, and the
  // driver watched a spinner nothing would ever clear. settleTurn closes the gap.
  private turnTerminalSent = false;

  // Unsubscribes the privacy watcher below. Held so a bridge that outlives its window
  // (the desktop builds one per window, in one process) stops writing to a transport
  // whose renderer is gone.
  private readonly unwatchPrivacy: () => void;

  constructor(private readonly cfg: RemoteBridgeConfig) {
    // The privacy switch has a second driver: `/privacy off` typed into the composer
    // (or into the CLI beside a driving app). Watch the flag itself rather than only
    // the frame, so the app's shield follows the terminal however it was moved — and
    // on the desktop, where the flag is process-wide, so does every OTHER window's,
    // which is the truth: they share the env var this writes.
    this.unwatchPrivacy = onPrivacyDisabledChange((off) => this.relay?.sendPrivacy?.(off));
  }

  /** Release what outlives a socket. Safe to call twice. */
  dispose(): void {
    this.unwatchPrivacy();
    if (this.questionGrace) clearTimeout(this.questionGrace);
    this.questionGrace = undefined;
    this.relay = undefined;
  }

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
      // A message typed while a question is open IS the answer to it. The app shows the
      // question as a sheet over the composer, and people answer by typing anyway — the
      // turn is blocked on the question, so the text has nowhere else useful to go.
      // Free text is a valid answer to both: ask_user_question's dialog walker reads a
      // reply that matches no option as the user's own answer.
      if (text.trim() && this.answerOpenQuestion(text)) return;
      // A message sent into a turn already in flight steers it (the owner decides how);
      // it must not restart the capture of the reply that turn is still writing.
      if (!this.turnDriven) {
        this.turnDriven = true;
        this.turnPrompt = text;
        this.turnText = "";
        this.turnTerminalSent = false;
      }
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
      this.pendingSelects.get(id)?.resolve(value);
    },
    onInputResponse: (id, value) => {
      this.pendingInputs.get(id)?.resolve(value);
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
      setNoQuarter(on);
      this.relay?.sendNoQuarter(on); // echo the ack back so the app's toggle syncs
    },
    // The app's privacy switch. It writes the SAME state `/privacy off` writes — the
    // env var every module copy and subagent child reads — so a session toggled from
    // the app and one toggled from the keyboard are the same session, and the CLI's
    // own `/privacy status` tells the truth about what the app did. Echoed back so
    // the app's switch reflects what this terminal is actually doing rather than what
    // it was asked to do.
    onPrivacy: (off) => {
      const changed = privacyDisabled() !== off;
      setPrivacyDisabled(off);
      // A real change is echoed by the watcher in the constructor (which also covers
      // `/privacy` typed at a composer). Ack a no-op ask here so an app whose switch
      // was already out of step still gets an answer rather than silence.
      if (!changed) this.relay?.sendPrivacy?.(off);
    },
    onControllerAttached: () => {
      if (this.noQuarter || noQuarterActive()) {
        this.relay?.sendNoQuarter(true);
      }
      // Resync the privacy switch the same way, and for a sharper reason: the filter
      // may have been turned off from the keyboard, or by a launch flag, or by an
      // earlier session of this app — an attaching controller must not paint a shield
      // over a terminal that has none. Sent only when OFF, so silence means protected.
      if (privacyDisabled()) this.relay?.sendPrivacy?.(true);
      // The app drops its open question sheets on every reconnect and expects the
      // terminal to say what is still being asked. Re-send under the SAME ids, so an
      // answer to the earlier frame (one that was in flight across the blip) still lands.
      this.resendOpenQuestions();
      this.cfg.onControllerAttached?.();
    },
    // The app left while we're still running. Same posture as a dropped socket: stop
    // treating the turn as remote (the gate must not wait on a controller that isn't
    // there) and fail every pending approval closed. The turn itself keeps going —
    // and settleTurn will deliver its answer to the outbox, since `turnDriven` (unlike
    // `remote`) survives the departure.
    onControllerDetached: () => {
      this.remote = false;
      this.rejectAllPending();
      this.holdOpenQuestions();
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
      this.holdOpenQuestions();
    },
  };

  // ── gate hooks (passed into the GateController) ─────────────────────────────

  getRemote = (): boolean => this.remote;
  getNoQuarter = (): boolean => this.noQuarter || noQuarterActive();

  /** True while the privacy filter is disabled for this session (`/privacy off`). */
  getPrivacyDisabled = (): boolean => privacyDisabled();

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
  // choice. Null if no controller when asked, or on abort. Unlike an approval, a
  // question is NOT failed by the app going away: it is held, re-sent on reattach,
  // and only gives up after questionGraceMs with nobody back (see holdOpenQuestions).
  // Callers get the chosen `value` or null.
  selectRemote = (req: SelectRequest, signal?: AbortSignal): Promise<string | null> => {
    if (!this.relay || !this.relay.isConnected()) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise<string | null>((resolve) => {
      const onAbort = () => settle(null);
      const settle = (v: string | null) => {
        this.pendingSelects.delete(id);
        signal?.removeEventListener("abort", onAbort);
        this.releaseQuestionGrace();
        resolve(v);
      };
      this.pendingSelects.set(id, { resolve: settle, req });
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.relay!.requestSelect(id, req);
    });
  };

  // A CLI-initiated free-form text prompt: relay it to the app and await the typed
  // line. Same posture as selectRemote — null if no controller when asked or on
  // abort, held across a detach. Callers get the submitted string or null.
  inputRemote = (req: InputRequest, signal?: AbortSignal): Promise<string | null> => {
    if (!this.relay || !this.relay.isConnected()) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise<string | null>((resolve) => {
      const onAbort = () => settle(null);
      const settle = (v: string | null) => {
        this.pendingInputs.delete(id);
        signal?.removeEventListener("abort", onAbort);
        this.releaseQuestionGrace();
        resolve(v);
      };
      this.pendingInputs.set(id, { resolve: settle, req });
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.relay!.requestInput(id, req);
    });
  };

  // ── turn lifecycle + event forwarding ───────────────────────────────────────

  // Mark the end of a turn so the next (possibly local) turn isn't treated as
  // remote. Call after each driven turn completes, passing the rejection message
  // if prompt() threw.
  //
  // A DRIVEN turn always leaves here with exactly one terminal event on the wire
  // (see turnTerminalSent): if the session never sent one, this sends it — `error`
  // carrying the throw, or a plain `finish` for a prompt Pi handled without
  // running the agent. Desktop's turnSupervisor emits its own terminal before it
  // settles, so it is seen here and never doubled.
  //
  // Also the one moment we can tell whether the turn had an audience. If the app
  // drove it and is now gone, everything the turn streamed up was dropped by the
  // relay — so hand the answer to the owner for durable delivery rather than letting
  // a completed piece of work evaporate because someone closed their phone.
  settleTurn(error?: string): void {
    const driven = this.turnDriven;
    const prompt = this.turnPrompt;
    const content = this.turnText.trim();
    if (driven && !this.turnTerminalSent) {
      this.forwardEvent(error
        ? { type: "error", error: redactText(error) }
        : { type: "finish", usage: emptyUsage(), finishReason: "stop" });
    }
    this.remote = false;
    this.turnDriven = false;
    this.turnPrompt = "";
    this.turnText = "";
    this.turnTerminalSent = false;
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
    if (ev.type === "finish" || ev.type === "aborted" || ev.type === "error") this.turnTerminalSent = true;
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
    // The three "nobody to ask" answers carry `unattached`, which is what lets the tool
    // queue the artifact for the app instead (cargoSave.ts). Nothing was sent, so there is
    // no chance a queued copy duplicates one the app stored.
    if (!this.relay) return Promise.resolve({ ok: false, unattached: true, reason: "remote access is not enabled — run /remote-access on and drive this terminal from the Privateer app" });
    if (!this.relay.isConnected()) return Promise.resolve({ ok: false, unattached: true, reason: "the relay is not connected" });
    // hasController is optional on RelayLike; a transport that can't tell is treated as
    // attached, matching how the rest of the bridge reads it.
    if (this.relay.hasController && !this.relay.hasController()) {
      return Promise.resolve({ ok: false, unattached: true, reason: "the Privateer app is not attached to this terminal" });
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

  /** Is a question (select or text prompt) waiting on the app? */
  hasOpenQuestion(): boolean {
    return this.pendingSelects.size > 0 || this.pendingInputs.size > 0;
  }

  // Answer the oldest open question with typed text. False when none is open.
  private answerOpenQuestion(text: string): boolean {
    const first = this.pendingSelects.values().next().value ?? this.pendingInputs.values().next().value;
    if (!first) return false;
    first.resolve(text);
    return true;
  }

  private resendOpenQuestions(): void {
    this.releaseQuestionGrace();
    for (const [id, q] of this.pendingSelects) this.relay?.requestSelect(id, q.req);
    for (const [id, q] of this.pendingInputs) this.relay?.requestInput(id, q.req);
  }

  // The app went away with questions open: keep them, but not forever.
  private holdOpenQuestions(): void {
    if (!this.hasOpenQuestion() || this.questionGrace) return;
    this.questionGrace = setTimeout(() => {
      this.questionGrace = undefined;
      for (const q of [...this.pendingSelects.values(), ...this.pendingInputs.values()]) q.resolve(null);
    }, questionGraceMs());
    this.questionGrace.unref?.();
  }

  private releaseQuestionGrace(): void {
    if (this.hasOpenQuestion() && this.questionGrace) return; // still waiting on the rest
    if (this.questionGrace) clearTimeout(this.questionGrace);
    this.questionGrace = undefined;
  }

  private rejectAllPending(): void {
    for (const resolve of this.pending.values()) resolve("deny");
    this.pending.clear();
    // Selects and text prompts are deliberately NOT failed here — see holdOpenQuestions.
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
