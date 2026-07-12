// Headless entry for the messaging channels — `npm run channels` (or
// `node --env-file=.env --import tsx src/channels/run.ts`). Boots the Pi stack the
// same way the routines daemon does, then bridges any configured chat platform
// (Telegram, Slack) to per-conversation agent sessions.
//
// AUTHORIZATION MODEL (per channel):
//   - admins  — governed by the channel `posture`; the ONLY users whose yes/no
//               resolves an approval prompt.
//   - members — may chat, but every turn runs read-only (writes/bash denied) and
//               they cannot answer approvals.
//   (Legacy `allowFrom` is treated as `admins` for back-compat.)
//
// POSTURE (config + restart only — deliberately no in-chat toggle; a restart is the
// fail-safe reset). Applies to ADMIN turns; members are always read-only:
//   - readonly — deny every write/edit/bash/fetch
//   - approve  — each risky action prompts an admin in-chat for yes/no  (default)
//   - auto     — non-dangerous actions run unattended; dangerous shell + destructive
//                actions still prompt
//   `tools` is the hard tool CEILING an admin can reach (default: read-only).
//
// MAINTENANCE: sessions are in-memory, per conversation, and evicted after 30 min
// idle or at a 500-session cap. A restart resets all live state to config (roles,
// posture). Every prompt/approval is appended to ~/.privateer/channels-audit.log.
// Tokens live in config.json in plaintext — protect that file's permissions.
//
// Config lives in ~/.privateer/config.json (the same file the daemon reads):
//   {
//     "defaultModel": "openrouter/openai/gpt-4o-mini",
//     "channels": {
//       "model":   "openrouter/openai/gpt-4o-mini", // optional shared override
//       "tools":   ["read","grep","find","ls"],      // optional shared ceiling
//       "posture": "approve",                         // optional shared default
//       "cwd":     "/path/to/project",                // optional (else process.cwd())
//       "telegram": { "botToken": "…", "admins": ["<tg-id>"], "members": ["<tg-id>"],
//                     "posture": "approve", "tools": ["read","grep","find","ls","edit","write","bash"] },
//       "slack":    { "appToken": "xapp-…", "botToken": "xoxb-…", "admins": ["<slack-id>"] },
//       "discord":  { "botToken": "…", "admins": ["<discord-id>"], "intents": 37376 },
//       "whatsapp": { "phoneNumberId": "…", "accessToken": "…", "verifyToken": "…",
//                     "appSecret": "…?", "port": 8787, "admins": ["<phone-number>"] }
//     }
//   }
// Each platform block is optional — only the configured ones start. Approvals are
// text-reply based (universal across all five platforms); mapping them to native
// buttons (Slack blocks / Discord components / Telegram inline keyboards) is a
// per-adapter enhancement.

import "../boot.ts"; // env + attestation dispatcher, before any Pi import
import { AsyncLocalStorage } from "node:async_hooks";

// Read-only default toolset — same rationale as the routines daemon's SAFE_TOOLS:
// a turn nobody is watching can't mutate the filesystem or shell out. Now that the
// gate routes approvals into the chat (see below), a user can safely widen this per
// channel via `channels.tools` — e.g. add "edit","write","bash" and each risky call
// prompts in-chat for a yes/no.
const SAFE_TOOLS = ["read", "grep", "find", "ls"];

// A channel's posture governs how an ADMIN's risky actions are handled (members are
// always capped to read-only — see effectivePosture). Config + restart only; there
// is deliberately no in-chat toggle.
//   readonly — deny every write/edit/bash/fetch (reads still run)
//   approve  — each risky action prompts in-chat for a yes/no (default)
//   auto     — non-dangerous actions run unattended; dangerous shell + destructive
//              actions still prompt
type Posture = "readonly" | "approve" | "auto";
const POSTURES: Posture[] = ["readonly", "approve", "auto"];

// Bound the live session map so a long-running daemon can't grow without limit or
// hold stale context forever.
const MAX_SESSIONS = 500;
const SESSION_IDLE_MS = 30 * 60 * 1000; // evict a conversation unused for 30 min
const SESSION_SWEEP_MS = 5 * 60 * 1000;

// Per-turn context. AsyncLocalStorage carries it across the async tool-call hooks so
// the SHARED gate knows which conversation to prompt and the EFFECTIVE posture for
// this turn (which already folds in the triggering user's role), even with several
// chats running concurrently.
interface ApprovalContext {
  bridge: { requestApproval(chatId: string, req: any, signal?: AbortSignal): Promise<"allow" | "deny"> };
  chatId: string;
  posture: Posture;
}
const approvalCtx = new AsyncLocalStorage<ApprovalContext>();

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

function normalizePosture(v: unknown): Posture | undefined {
  return typeof v === "string" && (POSTURES as string[]).includes(v) ? (v as Posture) : undefined;
}

async function main() {
  const { readFileSync, appendFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const {
    createAgentSessionServices,
    createAgentSessionFromServices,
    SessionManager,
  } = await import("@earendil-works/pi-coding-agent");
  const { createEngineEventAdapter } = await import("../bridge/engineAdapter.ts");
  const { makePermissionGate } = await import("../ext/permissionGate.ts");
  type GateController = import("../ext/permissionGate.ts").GateController;
  const { makePiPrivacyExtension } = await import("pi-privacy");
  const { makeAccountProvider } = await import("../providers/account.ts");
  const { agentDir, configPath, globalDir } = await import("../config/paths.ts");
  const { redactText, collectSecrets } = await import("../util/redact.ts");
  const { MessagingBridge } = await import("./bridge.ts");
  type TurnRunner = import("./bridge.ts").TurnRunner;
  const { TelegramAdapter } = await import("./telegram.ts");
  const { SlackAdapter } = await import("./slack.ts");
  const { DiscordAdapter } = await import("./discord.ts");
  const { WhatsAppAdapter } = await import("./whatsapp.ts");
  type ChannelAdapter = import("./types.ts").ChannelAdapter;

  // ── config ──────────────────────────────────────────────────────────────────
  let cfg: any = {};
  try {
    cfg = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    log(`no config at ${configPath()} — add a channels block (see run.ts header).`);
    process.exit(1);
  }
  const ch = cfg.channels ?? {};
  const defaultModel: string = ch.model ?? cfg.defaultModel ?? "openrouter/openai/gpt-4o-mini";
  const defaultTools: string[] = Array.isArray(ch.tools) && ch.tools.length ? ch.tools : SAFE_TOOLS;
  const defaultPosture: Posture = normalizePosture(ch.posture) ?? "approve";
  const cwd: string = ch.cwd ?? process.cwd();
  const secrets = collectSecrets(cfg.providers);
  const redact = (t: string) => redactText(t, secrets);

  // Append-only security audit log — every prompt, approval request/decision, and
  // refused non-admin approval, one JSON object per line.
  const auditPath = join(globalDir(), "channels-audit.log");
  const onAudit = (e: any) => {
    try {
      appendFileSync(auditPath, JSON.stringify(e) + "\n");
    } catch {
      /* best effort — never let auditing break a turn */
    }
  };

  // ── shared Pi session services (one registry/auth; sessions created per chat) ─
  //
  // The gate reads the EFFECTIVE posture for the current turn from the ALS store
  // (which already folded in the triggering user's role): a member always resolves
  // to "readonly". Mode "default" makes every write/edit/bash/fetch classify as
  // "ask"; "plan" (readonly) hard-denies them. getRemote() is always true so asks
  // route to the in-chat approver rather than a (non-existent) terminal. localAsk
  // stays deny as a fail-closed backstop.
  const posture = () => approvalCtx.getStore()?.posture;
  const gate: GateController = {
    getMode: () => (posture() === "readonly" ? "plan" : "default"),
    setMode: () => {},
    allowlist: [],
    allowedOutsideRoots: [],
    cwd,
    confineToCwd: true,
    getRemote: () => true,
    getNoQuarter: () => posture() === "auto",
    async localAsk() {
      return "deny";
    },
    async remoteAsk(req, signal) {
      const store = approvalCtx.getStore();
      if (!store) return "deny"; // no chat context → fail closed
      if (store.posture === "readonly") return "deny"; // read-only: deny, don't prompt
      return store.bridge.requestApproval(store.chatId, req, signal);
    },
  };
  const services = await createAgentSessionServices({
    cwd,
    agentDir: agentDir(),
    resourceLoaderOptions: {
      extensionFactories: [makePermissionGate(gate), makePiPrivacyExtension(), makeAccountProvider()] as any,
    },
  });

  const modelCache = new Map<string, any>();
  function resolveModel(spec: string): any {
    let m = modelCache.get(spec);
    if (m === undefined) {
      const { provider, modelId } = parseSpec(spec);
      m = (services.modelRegistry as any).find(provider, modelId) ?? null;
      modelCache.set(spec, m);
    }
    return m;
  }

  // One persistent session per conversation, keyed "<platform>:<chatId>" so chat
  // ids can't collide across platforms. A single subscription per session routes
  // streamed text to whichever turn is running (safe: the bridge serializes turns
  // per chat).
  interface SessionEntry {
    session: any;
    holder: { onText: (t: string) => void; error?: string };
    lastUsed: number;
  }
  const sessions = new Map<string, SessionEntry>();

  async function sessionFor(key: string, model: any, tools: string[]): Promise<SessionEntry> {
    let entry = sessions.get(key);
    if (!entry) {
      const { session } = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(cwd),
        model,
        tools,
      } as any);
      const adapter = createEngineEventAdapter();
      const holder: SessionEntry["holder"] = { onText: () => {}, error: undefined };
      session.subscribe((ev: any) => {
        for (const ee of adapter.toEngineEvents(ev)) {
          if (ee.type === "text") holder.onText(ee.text);
          else if (ee.type === "error") holder.error = ee.error;
        }
      });
      entry = { session, holder, lastUsed: Date.now() };
      sessions.set(key, entry);
      // Hard cap: evict the least-recently-used conversation if we're over budget.
      if (sessions.size > MAX_SESSIONS) {
        let oldestKey: string | undefined;
        let oldest = Infinity;
        for (const [k, e] of sessions) {
          if (e.lastUsed < oldest) {
            oldest = e.lastUsed;
            oldestKey = k;
          }
        }
        if (oldestKey && oldestKey !== key) sessions.delete(oldestKey);
      }
    }
    entry.lastUsed = Date.now();
    return entry;
  }

  // Idle sweep: drop conversations untouched for SESSION_IDLE_MS. A dropped chat's
  // next message just starts a fresh session (memory reset), so this is safe — turns
  // are serialized, so an in-flight turn keeps its session recently-used.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [k, e] of sessions) if (e.lastUsed < cutoff) sessions.delete(k);
  }, SESSION_SWEEP_MS);
  sweep.unref?.();

  // ── build a bridge per configured platform ───────────────────────────────────
  const bridges: { stop(): void }[] = [];

  async function startChannel(platform: string, adapter: ChannelAdapter, block: any) {
    // Roles. Legacy `allowFrom` is treated as admins (its prior meaning: the sole
    // fully-capable users). Members are chat-only + read-only and can't approve.
    const admins = new Set<string>((block.admins ?? block.allowFrom ?? []).map(String));
    const members = new Set<string>((block.members ?? []).map(String));
    if (admins.size === 0 && members.size === 0) {
      log(`${platform}: no admins/members configured — skipping (fail-closed).`);
      return;
    }

    const modelSpec: string = block.model ?? defaultModel;
    const model = resolveModel(modelSpec);
    if (!model) {
      log(`${platform}: model "${modelSpec}" not found — skipping. Check the spec / provider keys.`);
      return;
    }
    // Per-channel tool ceiling + posture. The ceiling is what admins CAN reach; the
    // gate caps members to read-only regardless.
    const chTools: string[] = Array.isArray(block.tools) && block.tools.length ? block.tools : defaultTools;
    const chPosture: Posture = normalizePosture(block.posture) ?? defaultPosture;

    // The runner references its own bridge (for approval routing via ALS), so the
    // bridge is declared first and assigned just below.
    let bridge: InstanceType<typeof MessagingBridge>;
    const runTurn: TurnRunner = async (chatId, text, onText, _signal, meta) => {
      const { session, holder } = await sessionFor(`${platform}:${chatId}`, model, chTools);
      holder.onText = onText;
      holder.error = undefined;
      // A member's turn is always read-only, whatever the channel posture.
      const effectivePosture: Posture = meta.isAdmin ? chPosture : "readonly";
      try {
        await approvalCtx.run({ bridge, chatId, posture: effectivePosture }, () => session.prompt(text));
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        holder.onText = () => {};
      }
      return holder.error ? { ok: false, error: holder.error } : { ok: true };
    };

    bridge = new MessagingBridge({
      adapter,
      runTurn,
      isAllowed: (m) => admins.has(m.userId) || members.has(m.userId),
      isAdmin: (m) => admins.has(m.userId),
      redact,
      onLog: log,
      onAudit: (e) => onAudit({ ...e, platform }),
    });
    await bridge.start();
    bridges.push(bridge);
    log(
      `${platform} up — model ${modelSpec}, ceiling [${chTools.join(", ")}], posture ${chPosture}, ` +
        `${admins.size} admin(s)/${members.size} member(s), cwd ${cwd}.`,
    );
  }

  if (ch.telegram?.botToken) {
    await startChannel(
      "telegram",
      new TelegramAdapter({ botToken: ch.telegram.botToken, onLog: log }),
      ch.telegram,
    );
  }
  if (ch.slack?.appToken && ch.slack?.botToken) {
    await startChannel(
      "slack",
      new SlackAdapter({ appToken: ch.slack.appToken, botToken: ch.slack.botToken, onLog: log }),
      ch.slack,
    );
  }
  if (ch.discord?.botToken) {
    await startChannel(
      "discord",
      new DiscordAdapter({ botToken: ch.discord.botToken, intents: ch.discord.intents, onLog: log }),
      ch.discord,
    );
  }
  if (ch.whatsapp?.phoneNumberId && ch.whatsapp?.accessToken && ch.whatsapp?.verifyToken) {
    await startChannel(
      "whatsapp",
      new WhatsAppAdapter({
        phoneNumberId: ch.whatsapp.phoneNumberId,
        accessToken: ch.whatsapp.accessToken,
        verifyToken: ch.whatsapp.verifyToken,
        appSecret: ch.whatsapp.appSecret,
        port: ch.whatsapp.port,
        path: ch.whatsapp.path,
        onLog: log,
      }),
      ch.whatsapp,
    );
  }

  if (bridges.length === 0) {
    log("no channels started — configure a channels.<platform> block in config.json.");
    process.exit(1);
  }

  const shutdown = () => {
    log("shutting down");
    clearInterval(sweep);
    for (const b of bridges) b.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
