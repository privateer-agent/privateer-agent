// A lean interactive REPL — enough to actually USE the agent and test the moat
// before the full pi-tui rewrite (Phase 6). Reuses everything built: the gate
// (with terminal y/n approval), the pi-privacy extension (providers + attestation),
// the EngineEvent adapter, and Pi's real session.
//
// Run:  nvm use && node --env-file=.env --import tsx src/cli/chat.ts
// Model: PRIVATEER_MODEL=provider/id  (else the account default when signed in, or a
//        BYO-keyed provider — see providers/defaultModel.ts)
//        e.g. tinfoil/llama3-3-70b to watch TEE posture go green.

import "../boot.ts"; // env + attestation dispatcher, before any Pi import
import { fileURLToPath } from "node:url"; // builtin, safe pre-boot
import { cliPalette } from "../ui/palette.ts"; // no Pi deps → safe pre-boot
import type { GateController } from "../ext/permissionGate.ts"; // type-only → erased, safe pre-boot

// This lean REPL has no Pi TUI (and so no Theme), so it detects the terminal background
// itself (COLORFGBG) and picks a palette — on a light terminal the standard "\x1b[33m"
// yellow / "\x1b[36m" cyan and faint "\x1b[2m" dim wash out, so cliPalette swaps in dark
// 256-colour indices there. On a dark terminal it's the same named colours as before.
const { RESET, DIM, CYAN, YELLOW, RED, GREEN } = cliPalette();

async function main() {
  const readline = await import("node:readline");
  const {
    createAgentSessionServices,
    createAgentSessionFromServices,
    SessionManager,
  } = await import("@earendil-works/pi-coding-agent");
  const { createEngineEventAdapter } = await import("../bridge/engineAdapter.ts");
  const { makePermissionGate, isRemoteUnsafeTool } = await import("../ext/permissionGate.ts");
  const { makePiPrivacyExtension, verifyModelPosture, TIERS } = await import("pi-privacy");
  const { agentDir } = await import("../config/paths.ts");
  const { RemoteBridge } = await import("../remote/remoteBridge.ts");
  const { startParentApprovalRelay } = await import("../remote/subagentRelay.ts");
  const { RelayClient } = await import("../remote/relayClient.ts");
  const { makeExtensionsControl } = await import("../remote/extensionsControl.ts");
  const { makeSkillsControl } = await import("../remote/skillsControl.ts");
  const { authorizeControl } = await import("../remote/controlAuth.ts");
  const { resolveMentions, completeMention, searchFiles } = await import("../util/fileMentions.ts");
  const priv = await import("../auth/privateer.ts");
  const { makeAccountProvider, accountPosture } = await import("../providers/account.ts");
  const { agentVersion } = await import("../config/version.ts");
  const { resolveDefaultModel, resolveSignedInModel } = await import("../providers/defaultModel.ts");

  // resolveDefaultModel() already honours PRIVATEER_MODEL first, then the account
  // default when signed in, then a BYO key — one source of truth (defaultModel.ts).
  const spec = resolveDefaultModel();
  const slash = spec.indexOf("/");
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  const cwd = process.cwd();
  // Point pi-subagents at our moat-injecting wrapper (unless overridden). This REPL
  // loads the gate/privacy/account as in-code factories, which a subagent child can't
  // inherit; the wrapper injects them explicitly (‑e) with discovery off, so children
  // run gated + private with no parent double-load. Also fixes the plain ENOENT: `pi`
  // isn't on PATH, so without this every subagent spawn would fail. See bin/privateer-
  // subagent.mjs. Absolute path, resolved relative to this module (src/cli/chat.ts).
  process.env.PI_SUBAGENT_PI_BINARY ??= fileURLToPath(new URL("../../bin/privateer-subagent.mjs", import.meta.url));
  // The live model spec ("provider/id"). Starts at the launch model and follows
  // /model switches, so the app banner + picker reflect what's actually selected.
  let currentSpec = spec;

  // Tab-completes an `@path` mention against the cwd tree (files the user can
  // reference in a prompt). readline calls this with the line up to the cursor; a
  // non-mention line returns no hits, leaving normal input untouched. Async form
  // (callback) so the filesystem read doesn't block the event loop.
  const completer = (line: string, cb: (err: null, result: [string[], string]) => void): void => {
    void completeMention(line, cwd).then((r) => cb(null, r)).catch(() => cb(null, [[], line]));
  };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer });
  let closed = false;
  rl.on("close", () => (closed = true));
  // Local terminal output is coalesced and prompt-aware. Two stutter sources it kills:
  //  1. Streaming a turn emits one delta per token; thousands of tiny stdout writes
  //     visibly stutter a TTY when a turn makes a lot of changes. We batch each burst
  //     into ~one write per frame (16 ms) instead.
  //  2. A mid-turn prompt (approval / input) awaits the user via rl.question. Output
  //     that streams in while it's pending prints INTO the question line, and readline
  //     redraws that line on every keystroke — the "action required" flicker. While a
  //     mid-turn prompt is pending we HOLD streamed output and flush it once they
  //     answer, so the question line stays clean.
  // Only the local path is batched; the relay path (bridge.forwardEvent) already does
  // its own coalescing (TEXT_FLUSH_MS) and is untouched.
  let outBuf = "";
  let outTimer: ReturnType<typeof setTimeout> | undefined;
  let holdDepth = 0; // >0 while a mid-turn prompt is awaiting the user
  const flushOut = (): void => {
    if (outTimer) { clearTimeout(outTimer); outTimer = undefined; }
    if (outBuf) { process.stdout.write(outBuf); outBuf = ""; }
  };
  const out = (s: string): void => {
    outBuf += s;
    if (holdDepth > 0) return; // held until the prompt resolves
    if (!outTimer) outTimer = setTimeout(flushOut, 16);
  };

  // Resolve to /quit if the input stream ends (EOF / Ctrl-D / piped input), incl.
  // if it closes while a question is pending, so we never throw USE_AFTER_CLOSE.
  const ask = (q: string): Promise<string> =>
    new Promise((res) => {
      if (closed) return res("/quit");
      flushOut(); // land buffered output ABOVE the prompt line
      // Hold streamed output only for a MID-TURN prompt. The idle top-level `›` must
      // still show a remote-driven turn streaming live, so don't hold when idle.
      const hold = turnActive;
      if (hold) holdDepth++;
      const settle = (v: string): void => {
        if (hold && holdDepth > 0 && --holdDepth === 0) flushOut();
        res(v);
      };
      const onClose = () => settle("/quit");
      rl.once("close", onClose);
      rl.question(q, (a) => {
        rl.off("close", onClose);
        settle(a);
      });
    });

  // Session + remote state, declared up front so the gate and the relay bridge can
  // reference them (they're assigned/used later, only at runtime).
  let session: any = null;
  let relay: any = null;
  let turnActive = false;
  // Pi-extension manager for the app's extensions screen (built after services below).
  let extensions: ReturnType<typeof makeExtensionsControl> | null = null;
  // Skills manager for the app's skills screen (built after services below).
  let skills: ReturnType<typeof makeSkillsControl> | null = null;

  // The relay bridge: wires the app (when /remote-access is on) to the same gate +
  // turn loop. Its gate hooks (getRemote/remoteAsk) are handed to the gate below,
  // so a remote-driven turn relays each tool to the phone instead of the terminal.
  const bridge = new RemoteBridge({
    onPrompt: (text) => void runTurn(text, true),
    onInterrupt: () => void session?.abort?.(),
    // The account signed this terminal out from the app (session revoked). Drop the
    // relay and wipe the local machine login so we don't keep reconnecting with a dead
    // token; the user re-runs /login to sign back in.
    onRevoked: () => {
      try { relay?.stop(); } catch { /* already stopped */ }
      relay = null;
      priv.handleServerRevoke();
      console.log(`\n${YELLOW}⟿ Signed out — this terminal's Privateer session was revoked from the app. Run /login to sign back in.${RESET}`);
    },
    // A slash command typed in the app composer (e.g. /model) — echo it (like the
    // prompt echo), then run it through the same dispatcher the local REPL uses.
    // Anything the dispatcher doesn't recognize falls through to the turn loop, so
    // Pi/extension/skill commands (which session.prompt executes) work remotely too.
    onCommand: (text) => {
      console.log(`\n${DIM}⟿ [app] ${text}${RESET}`);
      void (async () => { if (!(await runCommand(text, true))) await runTurn(text, true, false); })();
    },
    // On (re)attach, resync the transcript, push live context (model + version) so
    // the app's banner shows what this terminal runs, AND advertise the available
    // commands so the composer can autocomplete them (incl. extension commands). The
    // model catalog isn't pushed — /model relays it on demand as a selection prompt.
    // NON-PII: no cwd — see RelayClient.sendContext.
    onControllerAttached: () => {
      relay?.sendSnapshot([]);
      relay?.sendContext({ model: currentSpec, version: agentVersion() });
      relay?.sendCommands(availableCommands());
    },
    onStatus: (t) => console.log(`\n${DIM}⟿ ${t}${RESET}`),
    // The app composer is autocompleting an `@file` mention — list the cwd entries
    // matching the query and reply. Read-only + cwd-constrained (searchFiles never
    // escapes the subtree); resolution of the picked path happens on the prompt turn.
    onFilesSearch: (id, query) => void (async () => {
      try { bridge.sendFileMatches(id, await searchFiles(query, cwd)); }
      catch { bridge.sendFileMatches(id, []); }
    })(),
    // The app's extensions manager: list the user's installed Pi extensions, or
    // add/remove one. add/remove persist immediately but only load on the next
    // terminal launch — so the final frame flags needsRestart. See runExtMutation.
    onExtensionsList: () => relay?.sendExtensions({ installed: extensions?.listInstalled() ?? [] }),
    onExtensionsAdd: (source, sig, ts) => void runExtMutation("add", source, sig, ts),
    onExtensionsRemove: (source, sig, ts) => void runExtMutation("remove", source, sig, ts),
    // The app's skills manager: list the terminal's skills, or create/delete/toggle
    // a user one. A create/delete/toggle only reaches the model's <available_skills>
    // on the next launch (needsRestart); Run-now goes through the command frame as
    // /skill:name, which Pi expands immediately. See runSkillMutation.
    onSkillsList: () => relay?.sendSkills({ items: skills?.listSkills() ?? [] }),
    onSkillCreate: (skill, sig, ts) =>
      void runSkillMutation("skills_create", { name: skill.name, description: skill.description, instructions: skill.instructions }, () => skills!.createSkill(skill), "Saved", sig, ts),
    onSkillDelete: (name, sig, ts) => void runSkillMutation("skills_delete", { name }, () => skills!.deleteSkill(name), "Deleted", sig, ts),
    onSkillSetEnabled: (name, enabled, sig, ts) =>
      void runSkillMutation("skills_set_enabled", { name, enabled }, () => skills!.setEnabled(name, enabled), enabled ? "Enabled" : "Disabled", sig, ts),
  });

  // Watch the subagent approval channel: a subagent child's gated action (dangerous
  // shell / out-of-scope / destructive — the ones decideAuto forces to "ask") forwards
  // here and relays to the app over this session's bridge. The bridge fails closed while
  // no controller is attached, so an undriven terminal denies rather than auto-approves.
  startParentApprovalRelay(bridge, { onError: () => { /* best-effort; a poll error must not crash a turn */ } });

  // Verify an account-signed mutating control frame (H2) for this interactive terminal
  // before it acts — a forged extensions_add installs code, a forged skills_create
  // injects an auto-invoked skill. Binds this terminal's own relay id. Fail-closed: a
  // missing relay or an unsigned/forged/stale frame refuses the mutation.
  function guardInteractive(
    action: string,
    args: Record<string, unknown>,
    sig?: string,
    ts?: number,
  ): { ok: boolean; message?: string } {
    const termId = relay?.id as string | undefined;
    if (!termId) return { ok: false, message: "Remote access isn't active on this terminal." };
    return authorizeControl(termId, action, args, sig, ts);
  }

  // Run a skills create/delete/toggle for the app and relay the fresh list + result.
  // The final frame flags needsRestart on success so the app tells the user the
  // change reaches the model on relaunch (Run-now works without a restart).
  async function runSkillMutation(
    action: string,
    args: Record<string, unknown>,
    op: () => Promise<{ ok: boolean; message?: string }>,
    verb: string,
    sig?: string,
    ts?: number,
  ): Promise<void> {
    if (!skills) return;
    const auth = guardInteractive(action, args, sig, ts);
    if (!auth.ok) {
      relay?.sendSkills({ items: skills.listSkills(), message: auth.message });
      return;
    }
    const res = await op();
    relay?.sendSkills({
      items: skills.listSkills(),
      message: res.ok ? `${verb} — restart the terminal to update the model's skill list.` : res.message,
      needsRestart: res.ok,
    });
  }

  // Run an extensions add/remove for the app and relay progress → result. Progress
  // events (npm install / git clone steps) push busy frames; the final frame carries
  // the fresh list plus needsRestart so the app tells the user to relaunch to activate.
  async function runExtMutation(kind: "add" | "remove", source: string, sig?: string, ts?: number): Promise<void> {
    if (!extensions) return;
    const auth = guardInteractive(kind === "add" ? "extensions_add" : "extensions_remove", { source }, sig, ts);
    if (!auth.ok) {
      relay?.sendExtensions({ installed: extensions.listInstalled(), message: auth.message });
      return;
    }
    extensions.setProgress((ev) =>
      relay?.sendExtensions({
        installed: extensions!.listInstalled(),
        busy: ev.type !== "complete" && ev.type !== "error",
        message: ev.message,
      }),
    );
    try {
      const res = kind === "add" ? await extensions.add(source) : await extensions.remove(source);
      relay?.sendExtensions({
        installed: extensions.listInstalled(),
        message: res.ok
          ? `${kind === "add" ? "Added" : "Removed"} ${source} — restart the terminal to activate.`
          : res.message,
        needsRestart: res.ok,
      });
    } finally {
      extensions.setProgress(undefined);
    }
  }

  // Serialize turns so a remote prompt and a locally-typed one can't overlap.
  // `echo` prints the "⟿ [app] …" line; the caller suppresses it when it already
  // echoed (a fall-through command from onCommand).
  async function runTurn(text: string, remote: boolean, echo = true): Promise<void> {
    if (turnActive) {
      console.log(`\n${DIM}(busy — a turn is already running)${RESET}`);
      return;
    }
    turnActive = true;
    if (remote && echo) console.log(`\n${DIM}⟿ [app] ${text.slice(0, 80)}${RESET}`);
    try {
      // Expand any `@path` mentions into appended <file> blocks + image attachments,
      // resolved against this terminal's cwd (constrained to the cwd subtree). Both a
      // locally-typed prompt and an app-driven one land here, so both get it. A prompt
      // with no resolvable mention passes through unchanged. Unresolved tokens stay
      // inline; note them so a typo'd path isn't silently ignored.
      const mentions = await resolveMentions(text, cwd);
      if (mentions.skipped.length) {
        const m = `Couldn't attach: ${mentions.skipped.join(", ")} (must be a file inside ${cwd})`;
        console.log(`${DIM}${m}${RESET}`);
        if (remote) relay?.sendNotice(m);
      }
      await session.prompt(mentions.text, mentions.images.length ? { images: mentions.images } : undefined);
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
    // `--no-quarter` at launch (env PRIVATEER_NO_QUARTER) → total gate bypass, no prompts.
    getSkipAllPermissions: () => process.env.PRIVATEER_NO_QUARTER === "1",
    remoteAsk: bridge.remoteAsk,
    // Subagents (and their child-only intercom tools) can't be driven from the app
    // yet — pi-subagents runs each in a child session whose gate/UI bypass the relay,
    // so its prompts surface on THIS terminal, invisible to the driver. Block them on
    // a driven turn (fail-closed) and post a notice so the app shows why it stopped.
    blockedWhenRemote: isRemoteUnsafeTool,
    onRemoteBlocked: (toolName) => {
      const msg = `${toolName} is disabled while driving remotely — its prompts can't reach the app.`;
      console.log(`\n${DIM}⛔ ${msg}${RESET}`);
      bridge.sendNotice(msg);
    },
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

  // Pi-extension management for the app's extensions screen. Reuse the session's own
  // SettingsManager so the list reflects exactly what Pi loaded (and add/remove write
  // the same settings.json). The Privateer moat is excluded — it's shim files, not
  // configured "packages" (see extensionsControl).
  extensions = makeExtensionsControl({ cwd, agentDir: agentDir(), settingsManager: services.settingsManager });
  // Skills manager for the app's skills screen. Same SettingsManager so configured
  // skill paths + the user's <agentDir>/skills are both discovered.
  skills = makeSkillsControl({ cwd, agentDir: agentDir(), settingsManager: services.settingsManager });

  // Exit cleanup: revoke the server-side sessions THIS run created (the child API
  // session AND the account inference session) so the terminal drops off the app's
  // Linked Devices list the instant it closes — instead of lingering ~24h until its
  // token TTL. We also drop Pi's persisted account credential (auth.json) so the next
  // launch spawns a fresh session rather than reusing the one we just revoked (which
  // Pi wouldn't reactively refresh on the resulting 401). Idempotent + time-bounded so
  // a Ctrl+C during a slow network never hangs the exit. Registered BEFORE the account
  // spawn below so an early Ctrl+C still tears down whatever was created.
  let cleanedUp = false;
  async function cleanup(): Promise<void> {
    if (cleanedUp) return;
    cleanedUp = true;
    try { relay?.stop(); } catch { /* already stopped */ }
    try { await priv.revokeLocalSessions(); } catch { /* best effort — server TTL is the fallback */ }
    try { (services.authStorage as any).remove?.("privateer"); } catch { /* nothing persisted */ }
  }
  const onSignal = (): void => { void cleanup().finally(() => process.exit(0)); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // Account channel: seed the OAuth credential (a fresh child session) so getApiKey
  // resolves it; Pi then manages refresh on expiry via the registered oauth provider.
  if (provider === "privateer") {
    try {
      const creds = await priv.acquireAccountCredential();
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

  // Dialog UI for extensions/skills that ask the user to CHOOSE mid-turn (Pi's
  // ctx.ui.select/confirm/input). Without a bound uiContext Pi hands extensions a
  // no-op UI, so those prompts silently resolve to "cancelled" — the agent could
  // never ask a question. A remote-driven turn relays the choice to the app as the
  // same `select_request` the /model picker uses (→ the app's SelectionSheet, then
  // a `select_response` back); a local turn falls back to the terminal. This is a
  // separate channel from the permission gate (which relays as `approval_request`
  // → the app's global approval modal). Binding it also flips ctx.hasUI true, which
  // is correct: this REPL is interactive. The abort signal Pi passes (to dismiss a
  // dialog on interrupt) is threaded through so a cancelled turn doesn't wedge.
  const driven = (): boolean => bridge.getRemote() && bridge.isConnected();
  const uiContext = {
    // Pick one of `options`. Returns the chosen string, or undefined if cancelled.
    async select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> {
      if (!options.length) return undefined;
      if (driven()) {
        const choice = await bridge.selectRemote(
          { title, options: options.map((o) => ({ value: o, label: o })) },
          opts?.signal,
        );
        return choice ?? undefined;
      }
      flushOut(); // drain buffered stream output before the option list prints
      console.log(`\n${YELLOW}${title}${RESET}`);
      options.forEach((o, i) => console.log(`  ${DIM}${i + 1}.${RESET} ${o}`));
      const n = Number((await ask(`Choose [1-${options.length}]: `)).trim());
      return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : undefined;
    },
    // Yes/No. Remotely a two-option selection (the app has no dedicated confirm UI).
    async confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean> {
      if (driven()) {
        const choice = await bridge.selectRemote(
          { title: title || message, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
          opts?.signal,
        );
        return choice === "yes";
      }
      const a = (await ask(`\n${YELLOW}${title}${message ? ` — ${message}` : ""}${RESET} [y/N] `)).trim().toLowerCase();
      return a === "y" || a === "yes";
    },
    // Free-form text. A remote turn relays a text-input prompt to the app (its
    // own input sheet); a local turn reads the line over the terminal.
    async input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined> {
      if (driven()) {
        const value = await bridge.inputRemote({ title, placeholder }, opts?.signal);
        return value ?? undefined;
      }
      const a = await ask(`\n${YELLOW}${title}${placeholder ? ` (${placeholder})` : ""}: ${RESET}`);
      return a === "/quit" ? undefined : a;
    },
    // A one-line status message: printed locally and surfaced in the app's feed.
    notify(message: string, type?: "info" | "warning" | "error"): void {
      const color = type === "error" ? RED : type === "warning" ? YELLOW : DIM;
      console.log(`${color}${message}${RESET}`);
      if (driven()) bridge.sendNotice(message);
    },
  };
  await (session as any).bindExtensions({ uiContext });

  // Stream the turn as EngineEvents — printed locally AND forwarded to the app
  // (the relay only sends when a controller is attached, so this is safe always).
  const adapter = createEngineEventAdapter();
  session.subscribe((ev: any) => {
    for (const ee of adapter.toEngineEvents(ev)) {
      bridge.forwardEvent(ee);
      if (ee.type === "text") out(ee.text);
      else if (ee.type === "reasoning") out(`${DIM}${ee.text}${RESET}`);
      else if (ee.type === "tool-call") out(`\n${CYAN}⏺ ${ee.name}${RESET} ${DIM}${JSON.stringify(ee.input).slice(0, 120)}${RESET}\n`);
      else if (ee.type === "tool-result") out(`${DIM}  ↳ ${String(ee.output).slice(0, 200)}${RESET}\n`);
      else if (ee.type === "tool-error") out(`\n${RED}✗ ${ee.name}: ${ee.error}${RESET}\n`);
      else if (ee.type === "error") out(`\n${RED}error: ${ee.error}${RESET}\n`);
      else if (ee.type === "finish") { out("\n"); flushOut(); }
    }
  });

  async function showPosture() {
    // The account channel has its own posture (server-proxy attestation for near/,
    // ZDR policy otherwise); other providers go through pi-privacy.
    const res =
      provider === "privateer"
        ? await accountPosture(modelId)
        : await verifyModelPosture(provider, modelId, {
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
      // Move the live session onto a confidential model right away, so the next prompt
      // doesn't dead-end on the launch model's missing key. resolveSignedInModel picks
      // Tinfoil GLM 5.2 — direct with a Tinfoil key, over the subscription otherwise;
      // PRIVATEER_MODEL (a deliberate override) is respected and left alone.
      if (!process.env.PRIVATEER_MODEL?.trim()) {
        const target = resolveSignedInModel();
        if (target !== currentSpec) await switchModel(target, false);
      }
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

  const HELP = "Commands: /remote-access <on|off>  /login  /model <provider/id>  /models [filter]  /verify  /mode <…>  /quit";
  console.log(`${DIM}Ready. Type a prompt — reference a file with @path (Tab completes). ${HELP}${RESET}`);
  await showPosture();

  // The available model catalog as sorted "provider/id" specs. Same source the
  // /models list and the app's picker draw from.
  async function availableModelSpecs(): Promise<string[]> {
    const all: any[] = (services.modelRegistry as any).getAvailable ? await (services.modelRegistry as any).getAvailable() : [];
    return all.map((m) => `${m.provider}/${m.id}`).sort();
  }

  // Switch the live session's model in place (history preserved — see
  // AgentSession.setModel). Re-pushes context so the app's banner follows the
  // change; feedback goes to the console AND (when driven) the app.
  async function switchModel(specArg: string, remote: boolean): Promise<void> {
    const sp = specArg.trim();
    const at = sp.indexOf("/");
    if (at < 0) { const m = "Usage: /model provider/id"; console.log(`${RED}${m}${RESET}`); if (remote) relay?.sendNotice(m); return; }
    const p = sp.slice(0, at), id = sp.slice(at + 1);
    const model = (session.modelRegistry as any).find?.(p, id) ?? (services.modelRegistry as any).find?.(p, id);
    if (!model) { const m = `Model ${sp} not found — try /models.`; console.log(`${RED}${m}${RESET}`); if (remote) relay?.sendNotice(m); return; }
    try {
      await session.setModel(model);
      currentSpec = sp;
      const m = `model → ${sp}`;
      console.log(`${DIM}${m}${RESET}`);
      relay?.sendContext({ model: currentSpec, version: agentVersion() }); // banner follows the switch
      if (remote) relay?.sendNotice(m);
    } catch (e) {
      const m = `Couldn't switch model: ${(e as Error).message}`;
      console.log(`${RED}${m}${RESET}`);
      if (remote) relay?.sendNotice(m);
    }
  }

  // The terminal-driven model picker: relay THIS machine's real catalog to the app
  // as a selection prompt and switch to whatever the driver picks. This is the
  // remote /model flow — the terminal owns the options, the app just renders them.
  async function pickModelRemote(filter: string): Promise<void> {
    const specs = (await availableModelSpecs()).filter((sp) => !filter || sp.toLowerCase().includes(filter));
    const choice = await bridge.selectRemote({
      title: "Choose a model",
      options: specs.map((sp) => ({ value: sp, label: sp })),
      current: currentSpec,
    });
    if (choice) await switchModel(choice, true);
  }

  // Shared slash-command dispatcher for the local REPL and app-sent commands (the
  // relay `command` frame). Returns true when `line` was a recognized command, so
  // the REPL knows not to fall through and treat it as a prompt. `remote` commands
  // are driven from the app: they never touch local stdin and mirror feedback back
  // over the relay.
  async function runCommand(line: string, remote: boolean): Promise<boolean> {
    if (line === "/help" || line === "?") { console.log(`${DIM}${HELP}${RESET}`); if (remote) relay?.sendNotice(HELP); return true; }
    if (line === "/verify") { await showPosture(); return true; }
    // Enabling remote access is a physical-terminal action; ignore it if the app
    // (already remote) asks. Disabling remotely is the /remote-access off path,
    // which has its own terminate frame, so we don't handle it here for remote.
    if (line === "/remote-access" || line === "/remote-access on" || line === "/remote") { if (!remote) await remoteAccess(true); return true; }
    if (line === "/remote-access off") { if (!remote) await remoteAccess(false); return true; }
    if (line === "/login") { if (!remote) await login(); return true; }
    if (line.startsWith("/model ")) { await switchModel(line.slice(7), remote); return true; }
    // Bare /model (or /models [filter]) → the picker. Remote: relay the catalog as
    // a selection prompt the app renders; local: just print the list.
    if (line === "/model" || line === "/models" || line.startsWith("/models ")) {
      const filter = line.startsWith("/models ") ? line.slice(8).trim().toLowerCase() : "";
      if (remote) { await pickModelRemote(filter); return true; }
      const rows = (await availableModelSpecs()).filter((sp) => !filter || sp.toLowerCase().includes(filter));
      console.log(rows.slice(0, 40).join("\n") + (rows.length > 40 ? `\n${DIM}… ${rows.length - 40} more (try /models <filter>)${RESET}` : ""));
      return true;
    }
    // Extensions: remote drives the app's manager (list frame); local prints the list.
    if (line === "/extensions" || line === "/ext") {
      const installed = extensions?.listInstalled() ?? [];
      if (remote) { relay?.sendExtensions({ installed }); return true; }
      console.log(installed.length ? installed.map((e) => `  ${e.source}${e.installed ? "" : ` ${DIM}(not installed)${RESET}`}`).join("\n") : `${DIM}No extensions installed. Add them from the Privateer app.${RESET}`);
      return true;
    }
    // Skills: remote drives the app's manager (list frame); local prints the list.
    // Note `/skill:name` (invoke) is NOT handled here — it falls through to Pi.
    if (line === "/skills") {
      const items = skills?.listSkills() ?? [];
      if (remote) { relay?.sendSkills({ items }); return true; }
      console.log(items.length ? items.map((s) => `  ${s.name}${s.disabled ? ` ${DIM}(disabled)${RESET}` : ""}${s.editable ? "" : ` ${DIM}(read-only)${RESET}`} — ${s.description}`).join("\n") : `${DIM}No skills yet. Create them from the Privateer app.${RESET}`);
      return true;
    }
    if (line.startsWith("/mode ")) { mode = line.slice(6).trim() as typeof mode; const m = `mode → ${mode}`; console.log(`${DIM}${m}${RESET}`); if (remote) relay?.sendNotice(m); return true; }
    // Bare /mode → the picker (remote) or a hint (local).
    if (line === "/mode") {
      if (remote) {
        const choice = await bridge.selectRemote({
          title: "Permission mode",
          options: ["default", "acceptEdits", "plan", "bypass"].map((v) => ({ value: v, label: v })),
          current: mode,
        });
        if (choice) { mode = choice as typeof mode; relay?.sendNotice(`mode → ${mode}`); }
      } else {
        console.log(`${DIM}modes: default · acceptEdits · plan · bypass (current: ${mode})${RESET}`);
      }
      return true;
    }
    // Not one of THIS CLI's built-ins → not handled here. Both the local REPL and
    // the remote onCommand fall through to the turn loop, where Pi executes any
    // extension/skill command (or treats it as a prompt).
    return false;
  }

  // The commands the app should offer in its composer: this CLI's built-ins plus
  // whatever Pi extensions have registered (so the palette reflects the real,
  // extension-dependent command set — not a hardcoded list). Pushed on attach.
  function availableCommands(): { name: string; description?: string }[] {
    const builtins = [
      { name: "/model", description: "Switch the model" },
      { name: "/mode", description: "Change the approval mode (default/acceptEdits/plan/bypass)" },
      { name: "/models", description: "List available models" },
      { name: "/extensions", description: "Manage installed Pi extensions" },
      { name: "/skills", description: "Manage the terminal's skills" },
      { name: "/verify", description: "Re-check the model's privacy posture" },
      { name: "/help", description: "Show available commands" },
    ];
    let ext: { name: string; description?: string }[] = [];
    try {
      const reg = (session?.extensionRunner as any)?.getRegisteredCommands?.() ?? [];
      ext = reg.map((c: any) => ({ name: `/${c.invocationName ?? c.name}`, description: c.description }));
    } catch { /* no session/extensions yet */ }
    const seen = new Set(builtins.map((c) => c.name));
    return [...builtins, ...ext.filter((c) => !seen.has(c.name))];
  }

  for (;;) {
    const line = (await ask(`\n${CYAN}›${RESET} `)).trim();
    if (line === "/quit" || line === "/exit") break;
    if (!line) continue;
    if ((line.startsWith("/") || line === "?") && (await runCommand(line, false))) continue;
    await runTurn(line, false);
  }
  await cleanup();
  rl.close();
  console.log(`${DIM}bye.${RESET}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
