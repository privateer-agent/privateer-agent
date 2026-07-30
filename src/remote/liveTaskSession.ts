// A live, app-drivable agent session spawned on demand by the harbor (task_spawn,
// mode:"live"). Unlike a headless task (harbor/index.ts runTask → restricted tools +
// bypass gate + outbox), this stands up a FULL interactive session behind its own relay
// terminal so the app can attach and drive it in real time: stream tokens, approve each
// tool, interrupt. It is the same wiring cli/chat.ts uses for `/remote-access`, factored
// so the harbor can create one without a TTY.
//
// SAFETY: the gate runs in "default" mode, so on a driven turn every gated tool relays to
// the app for allow/deny (bridge.remoteAsk) and fail-closes if the controller is gone —
// full tools are safe precisely because a human is watching and approving. localAsk denies
// (there is no terminal to prompt), and remote-unsafe tools (subagents) are blocked.
import { randomUUID } from "node:crypto";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { agentDir } from "../config/paths.ts";
import { agentVersion } from "../config/version.ts";
import { createEngineEventAdapter } from "../bridge/engineAdapter.ts";
import { makePermissionGate, isRemoteUnsafeTool, type GateController } from "../ext/permissionGate.ts";
import { makePiPrivacyExtension } from "pi-privacy";
import {
  makeAccountProvider,
  privateerChannel,
  rememberAccountCredential,
  dropPersistedAccountCredential,
} from "../providers/account.ts";
import { RelayClient, type TaskSpec } from "./relayClient.ts";
import { RemoteBridge } from "./remoteBridge.ts";
import { makeRelayFileTools } from "../tools/relayFileTools.ts";
import { AttachmentStore, type StoredAttachment } from "../util/attachmentStore.ts";
import { spawnAccountCredentials, revokeAccountSession, hasCredentials } from "../auth/privateer.ts";
import { createUIContext } from "../ext/headlessUi.ts";
import { noQuarterActive } from "../permissions/noQuarter.ts";

export interface LiveTaskHandle {
  termId: string;
  label: string;
  stop: () => Promise<void>;
}

export interface LiveTaskDeps {
  defaultModel: string;
  parseSpec: (spec: string) => { provider: string; modelId: string };
  log: (msg: string) => void;
  onClosed: (termId: string) => void;
  // Deliver the session's closing answer durably (the harbor seals it to the account
  // outbox, so it lands in the app's inbox). A live spawn's feed is otherwise purely
  // ephemeral: close the screen, reap the session, and everything it said is gone —
  // unlike a submitted task or a routine, whose results are always sealed.
  onResult?: (result: { title: string; status: "ok" | "error"; content: string }) => void;
}

// How long to keep a spawned session alive with NO controller ever attaching, and the
// hard ceiling on any one session's lifetime (a driven session left open is reaped so an
// abandoned spawn can't run the account meter or hold resources forever).
const ATTACH_GRACE_MS = 180_000; // 3 min to attach after spawn
const MAX_LIFETIME_MS = 30 * 60_000; // 30 min absolute cap
// How long to wait for the spawned terminal to actually register on the relay before we give
// up and report the spawn as failed. `start()` resolves before the socket opens, so without
// this confirmation the harbor would announce a terminal the app can never attach to.
const REGISTER_TIMEOUT_MS = 20_000;

export async function createLiveTaskSession(spec: TaskSpec, deps: LiveTaskDeps): Promise<LiveTaskHandle> {
  const cwd = spec.cwd && spec.cwd.trim() ? spec.cwd : process.cwd();
  const modelSpec = spec.model && spec.model.trim() ? spec.model : deps.defaultModel;
  const title = spec.title && spec.title.trim() ? spec.title.trim() : "";
  const termId = `task-${randomUUID()}`;
  const label = title ? `Task: ${title}`.slice(0, 60) : "Privateer Task";

  let relay: RelayClient | undefined;
  let session: any;
  let turnActive = false;
  let attached = false;
  let initialPromptSent = false;
  let stopped = false;
  let spawnedAccount = false;
  let servicesRef: { authStorage?: { remove?: (p: string) => void; get?: (p: string) => unknown } } | null = null;

  let attachTimer: ReturnType<typeof setTimeout> | undefined;
  let lifeTimer: ReturnType<typeof setTimeout> | undefined;

  // Files the app sends down mid-session, keyed by the "#n" ref save_attachment writes
  // back out. `sinceLastPrompt` is drained into the next prompt so the model is told what
  // it just received — same contract as the TUI's (extensions/privateer-gate.ts).
  const attachments = new AttachmentStore();
  let sinceLastPrompt: StoredAttachment[] = [];

  // The assistant text of the most recent turn, accumulated from the event stream and
  // reset at the start of each one, so what we keep is the session's CLOSING answer
  // rather than a transcript. Bounded — the outbox truncates anyway, and a long
  // session's scrollback is not what makes a useful inbox entry.
  const MAX_RESULT_CHARS = 8000;
  let lastAnswer = "";
  let turnErrored = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Hand the closing answer over BEFORE tearing anything down. Best-effort by
    // design: no answer (nothing ever ran, or the model only used tools) means
    // nothing to deliver, and a delivery failure must never block teardown.
    const answer = lastAnswer.trim();
    if (answer && deps.onResult) {
      try {
        deps.onResult({
          title: title || "Spawned agent",
          status: turnErrored ? "error" : "ok",
          content: answer.slice(0, MAX_RESULT_CHARS),
        });
      } catch (e) {
        deps.log(`live task ${termId} result delivery failed: ${(e as Error).message}`);
      }
    }
    if (attachTimer) clearTimeout(attachTimer);
    if (lifeTimer) clearTimeout(lifeTimer);
    try { relay?.stop(); } catch { /* already stopped */ }
    attachments.cleanup(); // drop the scratch dir holding inbound file bytes
    // Revoke ONLY this session's account inference session so it doesn't linger in the
    // app's Linked Devices; the harbor's own child session stays alive. Best-effort.
    if (spawnedAccount) {
      try { await revokeAccountSession(); } catch { /* server TTL is the fallback */ }
      // Ownership-checked: auth.json is shared machine-wide, so a live task's teardown
      // must not delete an interactive terminal's entry (see providers/account.ts).
      try { dropPersistedAccountCredential({ modelRegistry: { authStorage: servicesRef?.authStorage } }); } catch { /* nothing persisted */ }
    }
    deps.onClosed(termId);
    deps.log(`live task ${termId} closed`);
  };

  const runTurn = async (text: string): Promise<void> => {
    if (turnActive || stopped) return;
    turnActive = true;
    lastAnswer = "";   // keep the CLOSING answer, not the whole session
    turnErrored = false;
    try {
      // Fold any files the app sent since the last prompt into a reference note, so the
      // model knows they exist and can save_attachment them to disk.
      const atts = sinceLastPrompt;
      sinceLastPrompt = [];
      const note = atts.length
        ? `\n\n[Files attached from the app: ${atts.map((a) => `#${a.n} ${a.name} (${a.mediaType})`).join(", ")}. ` +
          `Use the save_attachment tool with the ref number to write one to disk.]`
        : "";
      await session.prompt(text + note);
    } catch (e) {
      turnErrored = true;
      deps.log(`live task ${termId} turn error: ${(e as Error).message}`);
    } finally {
      turnActive = false;
      bridge.settleTurn();
    }
  };

  const bridge = new RemoteBridge({
    onPrompt: (text) => void runTurn(text),
    onInterrupt: () => void session?.abort?.(),
    // Slash commands from the app composer fall through to the turn loop (Pi executes
    // extension/skill commands via prompt). No local dispatcher here — this is headless.
    onCommand: (text) => void runTurn(text),
    onControllerAttached: () => {
      attached = true;
      if (attachTimer) { clearTimeout(attachTimer); attachTimer = undefined; }
      relay?.sendSnapshot([]);
      // cwd rides along here (and nowhere else — see RelayClient.sendContext): this
      // session's working directory was either named by the driver in the spawn form
      // or defaulted to the harbor's own, and they have no other way to see which.
      // Every file this agent touches is under it.
      relay?.sendContext({ model: modelSpec, cwd, version: agentVersion() });
      relay?.sendCommands([]);
      // Deliver the spawn's initial prompt exactly once, THROUGH the bridge's own prompt
      // path so it counts as a driven turn (remote=true → tools relay to the app).
      if (!initialPromptSent && spec.prompt && spec.prompt.trim()) {
        initialPromptSent = true;
        bridge.callbacks.onPrompt(spec.prompt);
      }
    },
    onAttachment: (file) => sinceLastPrompt.push(attachments.register(file)),
    onTerminate: () => void stop(),
    onStatus: (t) => deps.log(`live task ${termId}: ${t}`),
  });

  const gate: GateController = {
    getMode: () => "default",
    setMode: () => {},
    allowlist: [],
    allowedOutsideRoots: [],
    cwd,
    confineToCwd: true,
    // No terminal to ask — a LOCAL turn can't happen here, but fail closed if one ever
    // reaches this path.
    async localAsk() {
      return "deny";
    },
    getRemote: bridge.getRemote,
    getNoQuarter: bridge.getNoQuarter,
    // Session-wide TOTAL bypass when the harbor itself was launched `--no-quarter`
    // (env PRIVATEER_NO_QUARTER): every action auto-approves with no prompt, here as
    // in the TUI. Without this the flag meant nothing on a spawn — the app's own
    // no-quarter toggle (getNoQuarter above) was the only switch that reached this
    // gate, so an operator who had lowered the moat harbor-wide still got prompted
    // for everything. Off unless the flag is set, which launchd/systemd never does.
    getSkipAllPermissions: noQuarterActive,
    remoteAsk: bridge.remoteAsk,
    blockedWhenRemote: isRemoteUnsafeTool,
    onRemoteBlocked: (toolName) => bridge.sendNotice(`${toolName} is disabled while driving remotely — its prompts can't reach the app.`),
  };

  const services = await createAgentSessionServices({
    cwd,
    agentDir: agentDir(),
    resourceLoaderOptions: {
      extensionFactories: [
        makePermissionGate(gate),
        // Per-model verified-TEE label for the /models picker (see harbor/index.ts):
        // TEE-channel Privateer models verify on select when logged in; ZDR stays floored.
        makePiPrivacyExtension({
          privateerVerifiedTee: (m) => hasCredentials() && privateerChannel(m.id ?? "") === "tee",
        }),
        makeAccountProvider(),
        // send_file_to_client / save_attachment bound to THIS session's bridge — the one
        // whose relay the app is attached to. The shipped gate extension is discovered
        // into this session too but stands its own pair down inside the daemon, so these
        // are the ones the model gets (see tools/relayFileTools.ts).
        makeRelayFileTools(bridge, attachments),
      ] as any,
    },
  });
  servicesRef = services as any;

  const { provider, modelId } = deps.parseSpec(modelSpec);
  if (provider === "privateer") {
    try {
      const creds = await spawnAccountCredentials();
      (services.authStorage as any).set("privateer", { type: "oauth", ...creds });
      rememberAccountCredential(creds); // claim it, so stop() drops OUR entry only
      spawnedAccount = true;
    } catch (e) {
      deps.log(`live task ${termId} account channel unavailable: ${(e as Error).message}`);
    }
  }

  // From here on any failure MUST tear down (stop() revokes the account child session we
  // just spawned + closes the relay), or a throw would leak an orphaned account "device"
  // until its token TTL. Everything post-account-spawn runs under one guard.
  try {
  const model = (services.modelRegistry as any).find(provider, modelId);
  if (!model) {
    throw new Error(`model ${provider}/${modelId} not found`);
  }

  ({ session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    model,
    // No `tools` restriction: a live session gets Pi's full toolset, made safe by the
    // per-tool relay-to-app approval above.
  } as any));

  // Relay the extension mid-turn UI (select/confirm/input) to the app when driven, so an
  // extension asking a question doesn't silently cancel. Mirrors cli/chat.ts's uiContext.
  const driven = (): boolean => bridge.getRemote() && bridge.isConnected();
  const uiContext = createUIContext({
    async select(t: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> {
      if (!options.length) return undefined;
      if (!driven()) return undefined;
      const choice = await bridge.selectRemote({ title: t, options: options.map((o) => ({ value: o, label: o })) }, opts?.signal);
      return choice ?? undefined;
    },
    async confirm(t: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean> {
      if (!driven()) return false;
      const choice = await bridge.selectRemote({ title: t || message, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] }, opts?.signal);
      return choice === "yes";
    },
    async input(t: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined> {
      if (!driven()) return undefined;
      const value = await bridge.inputRemote({ title: t, placeholder }, opts?.signal);
      return value ?? undefined;
    },
    notify(message: string): void {
      if (driven()) bridge.sendNotice(message);
    },
  });
  await (session as any).bindExtensions({ uiContext });

  const adapter = createEngineEventAdapter();
  session.subscribe((ev: any) => {
    for (const ee of adapter.toEngineEvents(ev)) {
      // Assistant prose only — reasoning, tool calls and results are deliberately not
      // kept: the inbox entry should read like the agent's answer, not a trace.
      if (ee.type === "text" && lastAnswer.length < MAX_RESULT_CHARS) lastAnswer += ee.text;
      bridge.forwardEvent(ee);
    }
  });

  relay = new RelayClient(bridge.callbacks, { termId, label });
  bridge.attachRelay(relay);
  await relay.start();
  // start() resolves before the socket registers; confirm the terminal is actually live on
  // the relay BEFORE returning (→ the harbor announces task_spawned). Rejects on a hard
  // failure (e.g. the concurrency cap) or timeout → the catch below tears down and propagates,
  // so the harbor reports task_spawn_error instead of pointing the app at a dead terminal.
  await relay.awaitRegistered(REGISTER_TIMEOUT_MS);

  // Reap if nobody ever attaches, and cap the absolute lifetime regardless.
  attachTimer = setTimeout(() => { if (!attached) void stop(); }, ATTACH_GRACE_MS);
  lifeTimer = setTimeout(() => void stop(), MAX_LIFETIME_MS);
  } catch (err) {
    await stop(); // revoke the account child session + close the relay before propagating
    throw err;
  }

  return { termId, label, stop };
}
