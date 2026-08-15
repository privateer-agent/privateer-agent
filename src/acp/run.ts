// Headless ACP entry — `privateer acp`.
//
// An ACP host (Buzz's `buzz-acp`, Zed, …) spawns this process and drives it over
// newline-delimited JSON-RPC on stdio. This file is the Pi-side wiring; the protocol
// surface is ./server.ts and the pure mappings are ./protocol.ts.
//
// ⚠️ STDOUT IS THE PROTOCOL. Anything written to stdout that isn't a JSON-RPC frame
// corrupts the stream and the host drops the connection — usually with an opaque
// parse error. Every diagnostic here goes to STDERR, which hosts capture as the
// agent's log. This is the single easiest way to break an ACP agent, so the rule is
// absolute: no console.log, no process.stdout.write, anywhere under this entry.
//
// SECURITY POSTURE. The host renders approvals; it does not grant them. Privateer's
// permission gate still classifies every action, `localAsk` is a fail-closed deny,
// an unparseable or cancelled answer is a deny, and `tools` is a hard ceiling the
// host cannot widen. See src/acp/server.ts:askOverAcp.
//
// Config lives in ~/.privateer/config.json (the same file the harbor reads):
//   {
//     "acp": {
//       "model":   "openrouter/openai/gpt-4o-mini",   // optional
//       "tools":   ["read","grep","find","ls"],        // optional ceiling
//       "posture": "approve",                          // readonly | approve | auto
//       "cwd":     "/path/to/project"        // optional; else this process's cwd
//     }
//   }
//
// ⚠️ THE WORKING DIRECTORY IS PROCESS-WIDE, NOT PER SESSION. `baseCwd` is fixed at
// startup from `acp.cwd` (or, absent that, whatever cwd the host spawned us with),
// and it is what BOTH the tools and the permission gate use. The `cwd` a host sends
// in `session/new` is effectively ignored: we hand it to `SessionManager.inMemory`,
// but Pi's `createAgentSessionFromServices` passes `services.cwd` to
// `createAgentSession`, and `options.cwd` wins over `sessionManager.getCwd()` — so
// the session manager's copy never reaches a tool.
//
// This is currently FAIL-SAFE and must stay that way: gate and tools agree on one
// root, so there is no split-brain where the gate judges a path in one directory
// while a tool acts in another. Do NOT "fix" this by threading the host's cwd into
// `SessionManager` alone — that would move the tools without moving the gate, which
// is precisely the class of bug that made `~/…` paths bypass confinement. Honouring
// a per-session cwd properly means building services + gate per session, or scoping
// `gate.cwd` through an AsyncLocalStorage the way `turnCtx` scopes approvals.

import "../boot.ts"; // env + attestation dispatcher, before any Pi import
import { WEB_TOOL_NAMES } from "../tools/web.ts";
import { MEDIA_TOOL_NAMES } from "../tools/media.ts";

// Read-only by default, exactly as the channels runtime and the routines harbor do:
// a turn nobody is watching must not be able to mutate the filesystem or shell out
// until a human widens it in config.
const SAFE_TOOLS = ["read", "grep", "find", "ls"];
const WEB_TOOLS: string[] = [...WEB_TOOL_NAMES];
// Media generation stays out of the default set (it spends the account's credit —
// see the harbor's note); an ACP host that wants it names it in `acp.tools`. Listed
// here so it can be stripped back out when generation is switched off.
const MEDIA_GEN_TOOLS: string[] = [...MEDIA_TOOL_NAMES];

type Posture = "readonly" | "approve" | "auto";
const POSTURES: Posture[] = ["readonly", "approve", "auto"];

function normalizePosture(v: unknown): Posture | undefined {
  return typeof v === "string" && (POSTURES as string[]).includes(v) ? (v as Posture) : undefined;
}

// STDERR only — see the header.
function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] acp: ${msg}\n`);
}

function parseSpec(spec: string): { provider: string; modelId: string } {
  const i = spec.indexOf(":");
  const j = spec.indexOf("/");
  const sep = i === -1 ? j : j === -1 ? i : Math.min(i, j);
  if (sep <= 0) return { provider: spec, modelId: "" };
  return { provider: spec.slice(0, sep), modelId: spec.slice(sep + 1) };
}

export async function runAcp(): Promise<void> {
  const { readFileSync } = await import("node:fs");
  // Aliased: `resolve` is already the model-spec resolver below.
  const { resolve: resolveFsPath } = await import("node:path");
  const { Readable, Writable } = await import("node:stream");
  const { AgentSideConnection, ndJsonStream } = await import("@zed-industries/agent-client-protocol");
  const { createAgentSessionServices, createAgentSessionFromServices, SessionManager } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const { createEngineEventAdapter } = await import("../bridge/engineAdapter.ts");
  type GateController = import("../ext/permissionGate.ts").GateController;
  const { moatResourceOptions } = await import("../config/moat.ts");
  const { privateerChannel, rememberAccountCredential, persistAccountCredential, dropPersistedAccountCredential } =
    await import("../providers/account.ts");
  const { modelRegistryOf, piAuthStore } = await import("../providers/piAuthStore.ts");
  const { hasCredentials, acquireAccountCredential, revokeAccountSession } = await import("../auth/privateer.ts");
  const { webEnabled, mediaEnabled } = await import("../config/hosted.ts");
  const { resolveDefaultModel } = await import("../providers/defaultModel.ts");
  const { agentDir, configPath } = await import("../config/paths.ts");
  const { PrivateerAcpAgent, askOverAcp } = await import("./server.ts");
  type AcpSession = import("./server.ts").AcpSession;
  type TurnEvents = import("./server.ts").TurnEvents;

  let cfg: any = {};
  try {
    cfg = JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    /* no config is fine — defaults below are safe */
  }
  const block = cfg.acp ?? {};
  const defaultModel: string = resolveDefaultModel({ explicit: block.model ?? cfg.defaultModel });
  const web = webEnabled();
  const media = mediaEnabled();
  const tools: string[] = Array.isArray(block.tools) && block.tools.length
    ? block.tools.filter((t: string) => (web || !WEB_TOOLS.includes(t)) && (media || !MEDIA_GEN_TOOLS.includes(t)))
    : (web ? [...SAFE_TOOLS, ...WEB_TOOLS] : [...SAFE_TOOLS]);
  const posture: Posture = normalizePosture(block.posture) ?? "approve";
  const baseCwd: string = block.cwd ?? process.cwd();

  // The gate. Identical posture semantics to the channels runtime: "readonly" maps to
  // plan mode (hard-deny writes), "auto" relaxes non-dangerous actions, and every ask
  // routes REMOTELY — to the ACP host — because there is no terminal here. localAsk
  // stays a deny so a missing host can never mean "allowed".
  const gate: GateController = {
    getMode: () => (posture === "readonly" ? "plan" : "default"),
    setMode: () => {},
    allowlist: [],
    allowedOutsideRoots: [],
    cwd: baseCwd,
    confineToCwd: true,
    getRemote: () => true,
    getAutoApprove: () => posture === "auto",
    async localAsk() {
      return "deny";
    },
    async remoteAsk(req, signal) {
      if (posture === "readonly") return "deny"; // read-only: deny outright, don't prompt
      return askOverAcp(req, signal);
    },
  };

  const services = await createAgentSessionServices({
    cwd: baseCwd,
    agentDir: agentDir(),
    resourceLoaderOptions: {
      // ⚠️ LOAD THE MOAT ONCE. ~/.privateer/agent/extensions holds shims for the
      // interactive TUI's extensions, which Pi auto-discovers into every session
      // built against that agentDir. privateer-gate.ts is one of them, and it
      // installs its OWN permission gate wired to the relay bridge that only
      // `/remote-access` ever attaches. In this process that bridge is permanently
      // unattached, so its gate fails closed and DENIES every action before ours is
      // ever consulted — the host is never asked, and the model is told "denied by
      // the permission gate" with no prompt shown anywhere.
      //
      // Verified live: without this, `bash` was denied and remoteAsk never fired.
      //
      // The other entries now solve this with moatResourceOptions()'s extensionsOverride,
      // which drops OUR shims and keeps the user's. ACP stays on the blunter setting on
      // purpose: it also disables discovered MCP, and an ACP host supplies its own servers
      // in session/new, which is the more correct source here. So this list is the only way
      // a host (Zed, Buzz) gets the moat, the account provider, or media at all.
      noExtensions: true,
      ...((await moatResourceOptions({ kind: "acp", gate })) as any),
    },
  });

  const registry = modelRegistryOf(services) as any;
  const resolve = (spec: string) => {
    const { provider, modelId } = parseSpec(spec);
    return registry.find(provider, modelId) ?? null;
  };

  const model = resolve(defaultModel);
  if (!model) {
    log(`model "${defaultModel}" not found — check the spec and provider keys`);
    process.exit(1);
  }

  // The id we hand the host must round-trip back through parseSpec, so it is the
  // same "<provider>:<modelId>" spec the config file uses. Anything else and
  // session/set_model would hand us back a string we can't resolve.
  const specOf = (m: any): string => `${m.provider}:${m.id}`;

  // Every model with credentials configured — the same set /models offers. Marking
  // the confidential ones matters here: in a shared channel the humans reading the
  // picker cannot otherwise tell which choices keep their prompts inside a TEE.
  function listModels(): { available: any[]; currentModelId: string } | undefined {
    try {
      const byId = new Map<string, any>();
      // Models with an API key configured in authStorage.
      for (const m of (registry.getAvailable?.() ?? []) as any[]) byId.set(specOf(m), m);
      // …but the ACCOUNT provider authenticates with a child token rather than a
      // stored apiKey, so getAvailable() omits every privateer/* model — including,
      // absurdly, the default one we are already running on. Add back everything
      // from the current model's provider: if that provider works for the model in
      // use, its siblings are reachable too. This is what puts the confidential
      // TEE models in the host's picker at all.
      for (const m of (registry.getAll?.() ?? []) as any[]) {
        if (m.provider === model.provider) byId.set(specOf(m), m);
      }
      // Belt and braces: whatever else is true, the model we booted with is selectable.
      byId.set(specOf(model), model);

      const all = [...byId.values()];
      if (all.length === 0) return undefined;
      const available = all.map((m) => {
        const confidential = m.provider === "privateer" && privateerChannel(m.id ?? "") === "tee";
        return {
          modelId: specOf(m),
          name: m.name ?? m.id,
          description: [m.provider, confidential ? "confidential (TEE)" : undefined]
            .filter(Boolean)
            .join(" · "),
        };
      });
      return { available, currentModelId: specOf(model) };
    } catch (e) {
      log(`could not list models: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  // ── arm the account channel ───────────────────────────────────────────────────
  //
  // A `privateer/*` model runs on the account subscription, not an API key. Nothing
  // arms that automatically here: the TUI does it from an interactive hook and the
  // harbor does it explicitly per run (harbor/index.ts:958). Without this the model
  // call fails with Pi's "This terminal isn't signed in to Privateer" — which is
  // misleading, because the login is fine; it's the SESSION that never armed.
  //
  // This bit us silently: early runs worked only because a `privateer` entry left in
  // ~/.privateer/agent/auth.json by a previous TUI session happened to still be
  // there. The moment anything revoked it, every ACP turn started failing.
  let armedAccount = false;
  async function ensureAccountArmed(providerName: string): Promise<void> {
    if (providerName !== "privateer") return;
    // Re-read the PERSISTED entry instead of latching on `armedAccount`. auth.json holds
    // one machine-global `privateer` entry, so whichever terminal armed LAST removes it
    // on exit — including one that armed over ours — and a latch would never notice. The
    // session we hold stays perfectly valid while Pi sees no entry at all, so every turn
    // from then on fails with the misleading "This terminal isn't signed in to
    // Privateer". Re-arming reuses our own session (accountCredential's memo) rather
    // than minting a second one, so the recovery costs a store write, not a Linked
    // Devices row.
    if (armedAccount) {
      try {
        if (await (await piAuthStore()).read("privateer")) return;
      } catch {
        return; // can't read the store — leave it to the turn's own error path
      }
      log("account entry was removed by another terminal — re-arming");
    }
    if (!hasCredentials()) {
      log("not signed in to Privateer — run `privateer` and /login, or pick a BYO-key model");
      return;
    }
    try {
      const creds = await acquireAccountCredential();
      await persistAccountCredential(creds);
      rememberAccountCredential(creds); // claim it, so teardown drops OUR entry only
      armedAccount = true;
      log("account channel armed");
    } catch (e) {
      log(`account channel unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await ensureAccountArmed(model.provider);
  // The provider actually selected right now — `model` is the launch model and never
  // moves, but session/set_model can switch channels mid-run, and the per-turn re-arm
  // below has to follow that rather than the model this process booted on.
  let currentProvider = model.provider;

  const modelCount = listModels()?.available.length ?? 0;
  log(
    `ready — model ${defaultModel}, ${modelCount} selectable, ` +
      `ceiling [${tools.join(", ")}], posture ${posture}`,
  );

  // One Pi session per ACP session. A single subscription routes streamed text into a
  // mutable holder, which the running turn owns — safe because a session runs at most
  // one turn at a time (enforced in PrivateerAcpAgent.prompt).
  // NOTE `cwd` is the host's per-session directory and is NOT authoritative — see the
  // header. It is passed to SessionManager for bookkeeping only; tools and the gate
  // both run at `baseCwd`. Logged on session creation so a mismatch is visible rather
  // than silent.
  async function createSession(cwd: string, mcpServers: unknown[] = []): Promise<AcpSession> {
    if (cwd && resolveFsPath(cwd) !== resolveFsPath(baseCwd)) {
      log(`host asked for cwd ${cwd} but this process is confined to ${baseCwd} — using ${baseCwd}`);
    }
    // NOT SUPPORTED YET, and said out loud rather than dropped in silence. A host
    // may offer MCP servers in session/new; we can't connect them because
    // `noExtensions: true` (the fix for the discovered-gate collision) also
    // disables the MCP adapter. A user whose connector never appears deserves a
    // reason in the log instead of a mystery.
    if (Array.isArray(mcpServers) && mcpServers.length > 0) {
      log(`ignoring ${mcpServers.length} MCP server(s) offered by the host — not supported on the ACP path yet`);
    }
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd || baseCwd),
      model,
      tools,
    } as any);
    const adapter = createEngineEventAdapter();
    const noop: TurnEvents = { onText: () => {}, onToolStart: () => {}, onToolEnd: () => {} };
    const holder: { events: TurnEvents; error?: string } = { events: noop };
    session.subscribe((ev: any) => {
      for (const ee of adapter.toEngineEvents(ev)) {
        if (ee.type === "text") holder.events.onText(ee.text);
        else if (ee.type === "error") holder.error = ee.error;
        // Tool activity goes BOTH to the host (rendered as live progress — without
        // it a minute of tool work looks like a hang) and to stderr, where it is
        // the only way to tell a gate denial apart from the model simply choosing
        // not to call a tool. The model will happily narrate a refusal it invented.
        else if (ee.type === "tool-call") {
          log(`tool → ${ee.name}`);
          holder.events.onToolStart({ id: ee.id, name: ee.name });
        } else if (ee.type === "tool-error") {
          const error = String(ee.error).slice(0, 200);
          log(`tool ✗ ${ee.name}: ${error}`);
          holder.events.onToolEnd({ id: ee.id, name: ee.name, error });
        } else if (ee.type === "tool-result") {
          log(`tool ✓ ${ee.name}`);
          holder.events.onToolEnd({ id: ee.id, name: ee.name });
        }
      }
    });

    return {
      async setModel(spec: string) {
        const next = resolve(spec);
        if (!next) throw new Error(`unknown model: ${spec}`);
        // Switching INTO the account channel needs it armed too — a session that
        // started on a BYO-key model and moved to privateer/* would otherwise fail
        // with the same misleading "not signed in".
        await ensureAccountArmed(next.provider);
        await session.setModel(next);
        currentProvider = next.provider;
      },
      async prompt(text, events, signal) {
        holder.events = events;
        holder.error = undefined;
        try {
          // Ahead of every turn, not just at startup: the entry we armed can be removed
          // by another terminal's exit at any point in a long-lived host session (see
          // ensureAccountArmed). It has to happen HERE because pi's prompt() throws on
          // its own `hasConfiguredAuth` precheck before it emits `before_agent_start`,
          // where providers/account.ts installs the equivalent net.
          await ensureAccountArmed(currentProvider);
          await session.prompt(text);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        } finally {
          holder.events = noop;
        }
        if (signal.aborted) return { ok: false, error: "cancelled" };
        return holder.error ? { ok: false, error: holder.error } : { ok: true };
      },
    };
  }

  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  let agent: InstanceType<typeof PrivateerAcpAgent> | undefined;
  new AgentSideConnection((conn) => {
    agent = new PrivateerAcpAgent(conn, { createSession, models: listModels, onLog: log });
    return agent;
  }, stream);

  // The host closing stdin is the shutdown signal.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // stdin emits both "end" and "close"
    shuttingDown = true;
    log("host disconnected — shutting down");
    await agent?.shutdown();
    // Release this process's account inference session. The drop is OWNERSHIP-CHECKED
    // (providers/account.ts), which is what lets an interactive terminal — or another
    // ACP process, since a host may run several in parallel — keep its own auth.json
    // entry through our teardown instead of being signed out by it.
    if (armedAccount) {
      try {
        await revokeAccountSession();
      } catch {
        /* best effort — the server-side TTL is the fallback */
      }
      try {
        await dropPersistedAccountCredential();
      } catch {
        /* nothing persisted */
      }
    }
    process.exit(0);
  };
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Hold the process open; the connection lives on the stdio streams.
  await new Promise<void>(() => {});
}
