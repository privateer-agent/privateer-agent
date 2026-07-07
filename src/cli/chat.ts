// A lean interactive REPL — enough to actually USE the agent and test the moat
// before the full pi-tui rewrite (Phase 6). Reuses everything built: the gate
// (with terminal y/n approval), the pi-privacy extension (providers + attestation),
// the EngineEvent adapter, and Pi's real session.
//
// Run:  nvm use && node --env-file=.env --import tsx src/cli/chat.ts
// Model: PRIVATEER_MODEL=provider/id  (default openrouter/openai/gpt-4o-mini)
//        e.g. tinfoil/llama3-3-70b to watch TEE posture go green.

import "../boot.ts"; // env + attestation dispatcher, before any Pi import
import type { GateController } from "../ext/permissionGate.ts"; // type-only → erased, safe pre-boot

const RESET = "\x1b[0m", DIM = "\x1b[2m", CYAN = "\x1b[36m", YELLOW = "\x1b[33m", RED = "\x1b[31m", GREEN = "\x1b[32m";

async function main() {
  const readline = await import("node:readline");
  const {
    createAgentSessionServices,
    createAgentSessionFromServices,
    SessionManager,
  } = await import("@earendil-works/pi-coding-agent");
  const { createEngineEventAdapter } = await import("../bridge/engineAdapter.ts");
  const { makePermissionGate } = await import("../ext/permissionGate.ts");
  const { makePiPrivacyExtension, verifyModelPosture, TIERS } = await import("pi-privacy");
  const { agentDir } = await import("../config/paths.ts");
  const { RemoteBridge } = await import("../remote/remoteBridge.ts");
  const { RelayClient } = await import("../remote/relayClient.ts");
  const priv = await import("../auth/privateer.ts");
  const { makeAccountProvider } = await import("../providers/account.ts");

  const spec = process.env.PRIVATEER_MODEL ?? "openrouter/openai/gpt-4o-mini";
  const slash = spec.indexOf("/");
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const cwd = process.cwd();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on("close", () => (closed = true));
  // Resolve to /quit if the input stream ends (EOF / Ctrl-D / piped input), incl.
  // if it closes while a question is pending, so we never throw USE_AFTER_CLOSE.
  const ask = (q: string): Promise<string> =>
    new Promise((res) => {
      if (closed) return res("/quit");
      const onClose = () => res("/quit");
      rl.once("close", onClose);
      rl.question(q, (a) => {
        rl.off("close", onClose);
        res(a);
      });
    });

  // Session + remote state, declared up front so the gate and the relay bridge can
  // reference them (they're assigned/used later, only at runtime).
  let session: any = null;
  let relay: any = null;
  let turnActive = false;

  // The relay bridge: wires the app (when /remote-access is on) to the same gate +
  // turn loop. Its gate hooks (getRemote/remoteAsk) are handed to the gate below,
  // so a remote-driven turn relays each tool to the phone instead of the terminal.
  const bridge = new RemoteBridge({
    onPrompt: (text) => void runTurn(text, true),
    onInterrupt: () => void session?.abort?.(),
    onControllerAttached: () => relay?.sendSnapshot([]),
    onStatus: (t) => console.log(`\n${DIM}⟿ ${t}${RESET}`),
  });

  // Serialize turns so a remote prompt and a locally-typed one can't overlap.
  async function runTurn(text: string, remote: boolean): Promise<void> {
    if (turnActive) {
      console.log(`\n${DIM}(busy — a turn is already running)${RESET}`);
      return;
    }
    turnActive = true;
    if (remote) console.log(`\n${DIM}⟿ [app] ${text.slice(0, 80)}${RESET}`);
    try {
      await session.prompt(text);
    } catch (e) {
      console.log(`\n${RED}${(e as Error).message}${RESET}`);
    } finally {
      turnActive = false;
      if (remote) bridge.settleTurn();
    }
  }

  // The gate: local terminal approval, plus the remote branch via the bridge.
  let mode: "default" | "acceptEdits" | "bypass" | "plan" = "default";
  const gate: GateController = {
    getMode: () => mode,
    setMode: (m) => (mode = m),
    allowlist: [],
    allowedOutsideRoots: [],
    cwd,
    async localAsk(req) {
      const a = (await ask(`\n${YELLOW}⚠ Allow ${req.title}: ${req.detail}?${RESET} [y/N/a] `)).trim().toLowerCase();
      return a === "y" || a === "yes" ? "allow" : a === "a" || a === "always" ? "always" : "deny";
    },
    getRemote: bridge.getRemote,
    getNoQuarter: bridge.getNoQuarter,
    remoteAsk: bridge.remoteAsk,
  };

  console.log(`${DIM}privateer-agent — lean REPL. Loading ${provider}/${modelId}…${RESET}`);

  const services = await createAgentSessionServices({
    cwd,
    agentDir: agentDir(),
    resourceLoaderOptions: {
      // Structural ext types are intentionally narrow; cast to Pi's ExtensionFactory.
      extensionFactories: [makePermissionGate(gate), makePiPrivacyExtension(), makeAccountProvider()] as any,
    },
  });
  for (const d of services.diagnostics) if (d.type === "error") console.log(`${RED}! ${d.message}${RESET}`);

  // Account channel: seed the OAuth credential (a fresh child session) so getApiKey
  // resolves it; Pi then manages refresh on expiry via the registered oauth provider.
  if (provider === "privateer") {
    try {
      const creds = await priv.spawnAccountCredentials();
      (services.authStorage as any).set("privateer", { type: "oauth", ...creds });
    } catch (e) {
      console.log(`${RED}Account channel unavailable: ${(e as Error).message}${RESET}`);
    }
  }

  const model = (services.modelRegistry as any).find(provider, modelId);
  if (!model) {
    console.log(`${RED}Model ${provider}/${modelId} not found.${RESET} Set PRIVATEER_MODEL=provider/id and check the key is in .env.`);
    rl.close();
    process.exit(1);
  }

  ({ session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(cwd),
    model,
  } as any));

  // Stream the turn as EngineEvents — printed locally AND forwarded to the app
  // (the relay only sends when a controller is attached, so this is safe always).
  const adapter = createEngineEventAdapter();
  session.subscribe((ev: any) => {
    for (const ee of adapter.toEngineEvents(ev)) {
      bridge.forwardEvent(ee);
      if (ee.type === "text") process.stdout.write(ee.text);
      else if (ee.type === "reasoning") process.stdout.write(`${DIM}${ee.text}${RESET}`);
      else if (ee.type === "tool-call") process.stdout.write(`\n${CYAN}⏺ ${ee.name}${RESET} ${DIM}${JSON.stringify(ee.input).slice(0, 120)}${RESET}\n`);
      else if (ee.type === "tool-result") process.stdout.write(`${DIM}  ↳ ${String(ee.output).slice(0, 200)}${RESET}\n`);
      else if (ee.type === "tool-error") process.stdout.write(`\n${RED}✗ ${ee.name}: ${ee.error}${RESET}\n`);
      else if (ee.type === "error") process.stdout.write(`\n${RED}error: ${ee.error}${RESET}\n`);
      else if (ee.type === "finish") process.stdout.write("\n");
    }
  });

  async function showPosture() {
    const res = await verifyModelPosture(provider, modelId, {
      apiKey: provider === "nearai" ? process.env.NEARAI_API_KEY ?? process.env.NEAR_AI_API_KEY : undefined,
    });
    const t = TIERS[res.tier];
    const color = t.posture === "green" ? GREEN : t.posture === "yellow" ? YELLOW : DIM;
    console.log(`\n${color}⛉ ${t.label}${RESET} ${DIM}(${res.tier}${res.teePosture ? "/" + res.teePosture : ""}) — ${t.blurb}${RESET}${res.error ? `\n${RED}  ${res.error}${RESET}` : ""}`);
  }

  async function remoteAccess(on: boolean) {
    if (on) {
      if (relay) return console.log(`${DIM}remote access already on${RESET}`);
      if (!priv.hasCredentials()) return console.log(`${RED}Not signed in.${RESET} Run /login first.`);
      relay = new RelayClient(bridge.callbacks, { label: "privateer-cli" });
      bridge.attachRelay(relay);
      await relay.start();
      console.log(`${DIM}Remote access enabling — approve this terminal in the Privateer app, then drive it from there.${RESET}`);
    } else {
      relay?.stop();
      relay = null;
      console.log(`${DIM}remote access off${RESET}`);
    }
  }

  async function login() {
    console.log(`${DIM}Requesting a device code…${RESET}`);
    try {
      const user = await priv.runDeviceLogin({
        onCode: (code: any) => {
          console.log(`\n${CYAN}Approve this terminal in the Privateer app:${RESET}`);
          console.log(`  code: ${YELLOW}${code.user_code}${RESET}`);
          if (code.verification_uri_complete) console.log(`  or open: ${DIM}${code.verification_uri_complete}${RESET}`);
          console.log(`${DIM}  waiting for approval…${RESET}`);
        },
      });
      console.log(`${GREEN}Signed in as ${user.email ?? user.id}.${RESET}`);
    } catch (e) {
      console.log(`${RED}${(e as Error).message}${RESET}`);
    }
  }

  // Surface the account state so an inherited login (shared ~/.privateer/credentials.json
  // with the 0.2 CLI) isn't a surprise when /remote-access "just works".
  const who = priv.currentUser();
  console.log(
    who
      ? `${DIM}Signed in as ${who.email ?? who.id} ${DIM}(Privateer account — shared ~/.privateer login).${RESET}`
      : `${DIM}Not signed in. /login to enable remote access & the account provider.${RESET}`,
  );

  const HELP = "Commands: /remote-access <on|off>  /login  /models [filter]  /verify  /mode <…>  /quit";
  console.log(`${DIM}Ready. Type a prompt. ${HELP}${RESET}`);
  await showPosture();

  for (;;) {
    const line = (await ask(`\n${CYAN}›${RESET} `)).trim();
    if (line === "/quit" || line === "/exit") break;
    if (line === "/verify") { await showPosture(); continue; }
    if (line === "/remote-access" || line === "/remote-access on" || line === "/remote") { await remoteAccess(true); continue; }
    if (line === "/remote-access off") { await remoteAccess(false); continue; }
    if (line === "/login") { await login(); continue; }
    if (line === "/help" || line === "?") { console.log(`${DIM}${HELP}${RESET}`); continue; }
    if (line.startsWith("/models")) {
      const filter = line.slice(7).trim().toLowerCase();
      const all: any[] = (services.modelRegistry as any).getAvailable ? await (services.modelRegistry as any).getAvailable() : [];
      const rows = all.map((m) => `${m.provider}/${m.id}`).filter((s) => !filter || s.toLowerCase().includes(filter)).sort();
      console.log(rows.slice(0, 40).join("\n") + (rows.length > 40 ? `\n${DIM}… ${rows.length - 40} more (try /models <filter>)${RESET}` : ""));
      continue;
    }
    if (line.startsWith("/mode ")) { mode = line.slice(6).trim() as typeof mode; console.log(`${DIM}mode → ${mode}${RESET}`); continue; }
    if (!line) continue;
    await runTurn(line, false);
  }
  relay?.stop();
  rl.close();
  console.log(`${DIM}bye.${RESET}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
