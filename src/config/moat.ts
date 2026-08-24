/**
 * buildMoat() — the one place that decides which extensions a session gets, in what order.
 *
 * WHAT THIS REPLACES. Six entry points each hand-assembled their own `extensionFactories`
 * array: the harbor's sessions (routines, workflows, tasks), its live task spawns, the
 * channels runner, ACP, the dev REPL, and the desktop app's per-window session. The lists
 * were the same list — same gate, same privacy extension, same account provider, the same
 * `webEnabled()`/`mediaEnabled()` conditionals — copied with small deliberate differences
 * and a large amount of duplicated comment explaining them. Nothing held them together, so
 * an extension added to one path silently didn't exist on the others (privateer-media had
 * reached three of five), and the ordering rule below lived as prose repeated in each copy.
 *
 * THE DESKTOP IS WHY THIS NOTE IS NOW ABOUT SIX. It was left out of the first pass and
 * proved the point within the month: the app's Super Computer had NO generation tools at
 * all — no generate_image / _video / _model / _speech / _music / _sfx, no
 * media_capabilities, and not even video_compose, which every other kind gets
 * unconditionally because it is local ffmpeg work that costs nothing. Its MCP connectors
 * worked, so Godot and Unreal drove the editor fine while the same window could not make
 * a texture to put in it. The lesson is the one this module was written for: the fix is
 * not "add the media factory to that array", it is "there are no arrays".
 *
 * ORDER MATTERS, ONCE. pi-privacy's own catalog registers a `privateer` provider (its
 * PUBLIC developer-key channel, one seed model), and Pi's registerProvider REPLACES a
 * provider's models and request config. So the privacy extension must be built ABOVE
 * makeAccountProvider(), or the ACCOUNT channel doesn't land last, the default model stops
 * resolving, and requests go to api.privateer.pro/v1 instead of /api/agent/v1. Expressing
 * that as one ordered array is the point: it used to be a comment that each copy had to
 * keep. (The interactive TUI still gets its extensions by discovery, where the order isn't
 * ours to choose — which is why extensions/privateer-privacy.ts has to re-assert the
 * account registration there. Folding the TUI into this function is the next step.)
 *
 * CAPABILITY SHAPING. web and media are omitted as FACTORIES, not merely dropped from the
 * allow-list, when their switch is off: "web off" should mean the tool doesn't exist for
 * that run, not that it exists and is denied. The per-kind table below records which paths
 * get what — it is the behaviour the five copies already had, now readable in one place.
 *
 * IMPORT-SAFETY: every Pi-touching import is dynamic, inside the async function. So this
 * module is safe to import statically from anywhere, including a pre-boot entry (the REPL
 * loads everything Pi-touching after ../boot.ts, and this must not break that).
 */

import { basename } from "node:path";
import { managedNames } from "./moatManifest.ts";
import type { GateController } from "../ext/permissionGate.ts";
import type { SendFileBridge } from "../tools/sendFile.ts";
import type { CargoSaveBridge } from "../tools/cargo.ts";
import type { ChartOpBridge } from "../tools/charts.ts";
import type { AttachmentStore } from "../util/attachmentStore.ts";

/** A Pi extension factory, as DefaultResourceLoader takes them. */
export type ExtensionFactory = (pi: any) => void;

/**
 * Which session is being built. Not cosmetic: it selects the capability row below, so a
 * new entry point has to say what it is rather than inherit whatever the copy it was
 * pasted from happened to have.
 */
export type MoatKind =
  | "harbor-session" // routines, workflows, submitted tasks (headless, unattended)
  | "live-task" // a drivable session the harbor spawns for the app
  | "channels" // Telegram / Slack / Discord / WhatsApp bridge sessions
  | "acp" // `privateer acp` — an ACP host (Zed, Buzz) drives
  | "repl" // the lean dev REPL (npm run chat)
  | "desktop"; // the desktop app's Super Computer — one session per window

export interface MoatOptions {
  kind: MoatKind;
  /** This session's gate — its cwd, its approver. Never shared between sessions. */
  gate: GateController;
  /**
   * send_file_to_client / save_attachment bound to THIS session's bridge. Only a path that
   * owns a relay passes these; the shipped gate extension registers its own pair against
   * its module-level bridge and stands them down inside the daemon, so a live spawn's own
   * pair is what the model gets (see tools/relayFileTools.ts).
   */
  relayFiles?: { bridge: SendFileBridge & CargoSaveBridge & ChartOpBridge; attachments: AttachmentStore };
  /**
   * THIS run's inbox-attachment staging area (routines/resultMedia.ts). Passed only by
   * a path whose result reaches the app's Inbox — a scheduled routine, a submitted
   * task — and never shared between runs, so yesterday's staged file can't ride along
   * with today's. Absent ⇒ attach_to_result doesn't exist for the session, which is
   * the point: a run whose result goes to a webhook or a file has nothing to attach to.
   */
  resultMedia?: import("../routines/resultMedia.ts").ResultMedia;
  /**
   * What a SIGNED-OUT session hears when it calls web_search / web_fetch. Required by
   * `web: "guarded"` and ignored otherwise. It lives on the caller because only the caller
   * knows what the user can do about it — a desktop window can point at its account menu,
   * a headless host has no menu to point at (src/tools/web.ts).
   */
  webHint?: string;
  /**
   * How to import a THIRD-PARTY dependency (today: pi-mcp-adapter). Defaults to a plain
   * dynamic import, which is right for every process that runs from a normal Node
   * resolution root.
   *
   * The desktop is not one. It runs the agent's copy of every shared package — one Pi
   * instance, one captured-cert map — so it resolves from privateer-agent's own
   * package.json rather than the app's, and it needs a fallback for adapters whose entry
   * is an `index.ts` (under Electron, tsx's `register()` patches only the ESM loader, so
   * a vanilla CJS resolve looks for index.js and reports MODULE_NOT_FOUND). Taking the
   * resolver from the host keeps that knowledge in the host, where it belongs, instead of
   * teaching this module about Electron.
   */
  hostImport?: (spec: string) => Promise<any>;
}

/**
 * Per-kind capabilities. `web` and `media` are the CEILING — each is still ANDed with its
 * runtime switch (webEnabled/mediaEnabled), so a false here means "never", not "by default".
 *
 * web is deliberately off for live-task and repl: the account form routes through the
 * account API precisely because an unattended run must not hold a search provider key, and
 * both of those paths have a human at the other end who can use their own provider
 * (src/tools/web.ts). compose is unconditional everywhere: local ffmpeg work, no account,
 * no network, no spend — so a run with generation off can still assemble media that
 * already exists on disk.
 *
 * The three optional rows below are all FALSE for the unattended kinds, which is exactly
 * what those five paths did before the desktop joined the table. They exist because the
 * desktop is the first ATTENDED session built from here, and an attended session differs
 * from a headless one in ways that are real rather than cosmetic — a project context file
 * to load, a folder whose skills follow it, and a model PICKER whose registry has to be
 * repaired. Leaving them off keeps every pre-existing kind byte-identical.
 */
interface MoatCaps {
  /**
   * false     — never; the tools do not exist for this kind.
   * "account" — registered only once webEnabled() says there are credentials. The
   *             UNATTENDED shape: decide at build, because nothing will change mid-run.
   * "guarded" — always registered, each call re-checks sign-in and answers with
   *             `webHint` when there is none. The ATTENDED shape: the session outlives
   *             `/signin`, so the question has to be asked when the tool RUNS
   *             (src/tools/web.ts spells out why these are two functions, not one).
   */
  web: false | "account" | "guarded";
  media: boolean;
  mcp: boolean;
  /** PRIVATEER.md project context + /init (extensions/privateer-context.ts). */
  context?: boolean;
  /** The folder's own skills, contributed from ~/.privateer rather than the user's tree. */
  spawnSkills?: boolean;
  /**
   * Load the privacy SHIM (extensions/privateer-privacy.ts) rather than the bare
   * privacyExtension() below — the same configuration plus two provider REPAIRS.
   * pi-privacy re-registers `tinfoil` with a one-model seed catalog and `privateer` with
   * its public developer-key channel, and registerProvider REPLACES a provider's models.
   * A kind that resolves ONE configured model never notices; a kind with a model picker
   * does, loudly — every build throwing "Model tinfoil/… not found" on a machine with a
   * working key. See the shim's header for the full account.
   */
  privacyRepairs?: boolean;
}

const CAPABILITIES: Record<MoatKind, MoatCaps> = {
  "harbor-session": { web: "account", media: true, mcp: true },
  "live-task": { web: false, media: true, mcp: false },
  channels: { web: "account", media: true, mcp: false },
  acp: { web: "account", media: true, mcp: false },
  repl: { web: false, media: true, mcp: false },
  desktop: { web: "guarded", media: true, mcp: true, context: true, spawnSkills: true, privacyRepairs: true },
};

/**
 * Drop the launcher's shims from a session's DISCOVERED extension set, leaving everything
 * else — the user's own `packages`, their own files in <agentDir>/extensions — untouched.
 *
 * THE PROBLEM. bin/privateer-launch.mjs installs the moat as shim files in the shared
 * ~/.privateer/agent/extensions, and Pi discovers those into EVERY session built against
 * that agent dir — including the ones the harbor daemon, the channels runner and the REPL
 * stand up with their own in-code moat. So each of those processes got two copies of the
 * moat: one wired to the session it belongs to, and one wired to module-level state from a
 * process that isn't running (a RemoteBridge only `/remote-access` ever attaches a relay
 * to, an allowlist shared across concurrent sessions, and process.cwd() rather than the
 * session's). Pi runs every tool_call handler and resolves duplicate tool names
 * first-registration-wins with discovered extensions loading BEFORE inline factories, so
 * the stray copy either raised a second approval dialog for the same call (where a UI was
 * bound) or fail-closed denied it before the session's real approver was consulted (where
 * one wasn't) — and its tools shadowed the session's own.
 *
 * WHAT WE DID BEFORE. Each affected extension asked, from inside itself, whether its
 * consumer wanted it: `discoveredGateApplies()`, `inHarborDaemon()`, `isSubagentChild()`,
 * coordinated through process.env because jiti loads discovered extensions with the module
 * cache off, so two copies of a module don't share memory. That inverted the dependency
 * (the moat knew about the harbor), covered only the extensions someone had remembered to
 * defend — the media, MCP, web and brand shims never stood down at all — and had to be
 * repeated in each new entry point. The REPL was simply missed, and ran two gates.
 *
 * WHAT WE DO NOW. The host decides. Pi's own `extensionsOverride` hook runs over the
 * discovered set before inline factories are applied, so a process that builds its own moat
 * filters ours out by name and keeps the user's. Positive, one place, and it cannot be
 * forgotten by a new entry point because it ships with the factories it complements.
 *
 * Matching is by file basename against the shipping manifest: the launcher owns those
 * names (extensionsControl refuses to install a user package under any of them), and the
 * basename is stable where an absolute path is not — Pi reports the shim's own path, but
 * tmpdir symlinks and Windows separators make full-path equality a trap.
 *
 * WHAT THIS DOES NOT DO. Pi runs the override AFTER loading, so a dropped shim's module
 * has still been evaluated and its factory still ran — we stop it being dispatched to and
 * owning tool names, not being executed. Two consequences. Its tool registrations collide
 * with ours during load, producing conflict diagnostics that name an extension the session
 * is about to discard; those are noise, so we drop them alongside it (an entry point that
 * printed them would tell the user a tool conflicts with something not in the session).
 * And any side effect in the extension body still happens, which is why the shipped gate
 * keeps its own stand-down checks for now. Stopping the load itself means not putting the
 * shims in the discovered directory at all — passing them to the TUI as explicit `-e` args
 * the way bin/privateer-subagent.mjs already does for children — which also has to move
 * TUI-spawned subagents onto that wrapper. Separate change.
 */
export function excludeDiscoveredMoat(): (base: any) => any {
  const managed = new Set(managedNames());
  const name = (p: unknown): string => basename(String(p ?? "")).replace(/\.(ts|js|mjs|cjs)$/, "");
  return (base: any) => {
    const dropped: string[] = [];
    const extensions = (base?.extensions ?? []).filter((e: any) => {
      if (!managed.has(name(e?.path))) return true;
      dropped.push(String(e?.path ?? ""));
      return false;
    });
    // A diagnostic is ours to drop when it belongs to a shim we removed, or when it points
    // at one — "Tool X conflicts with <shim path>" is reported against the OTHER extension.
    const errors = (base?.errors ?? []).filter(
      (e: any) =>
        !managed.has(name(e?.path)) &&
        !dropped.some((p) => p && String(e?.error ?? "").includes(p)),
    );
    return { ...base, extensions, errors };
  };
}

/**
 * Everything a session's resourceLoaderOptions needs: our factories, plus the filter that
 * stops the discovered copies of those same extensions loading alongside them. Callers
 * should prefer this over buildMoat() — passing the factories without the filter is the
 * bug described above.
 */
export async function moatResourceOptions(
  opts: MoatOptions,
): Promise<{ extensionFactories: ExtensionFactory[]; extensionsOverride: (base: any) => any }> {
  return { extensionFactories: await buildMoat(opts), extensionsOverride: excludeDiscoveredMoat() };
}

/** Build the ordered extension factory list for one session. */
export async function buildMoat(opts: MoatOptions): Promise<ExtensionFactory[]> {
  const caps = CAPABILITIES[opts.kind];
  if (!caps) throw new Error(`buildMoat: unknown kind "${opts.kind}"`);

  const { makePermissionGate } = await import("../ext/permissionGate.ts");
  const { makeAccountProvider } = await import("../providers/account.ts");
  const { webEnabled, mediaEnabled } = await import("./hosted.ts");

  const factories: ExtensionFactory[] = [makePermissionGate(opts.gate)];

  // pi-privacy is configured in exactly ONE place, shared with the DISCOVERED copy of this
  // extension (the TUI's, and every subagent child's) — see ./privacyPolicy.ts for the two
  // bugs that came of configuring it in two. `privacyRepairs` picks which of the two
  // ROUTES into that one configuration a kind takes, never which options it gets.
  if (caps.privacyRepairs) {
    const { default: privateerPrivacy } = await import("../../extensions/privateer-privacy.ts");
    factories.push(privateerPrivacy);
  } else {
    const { privacyExtension } = await import("./privacyPolicy.ts");
    factories.push(privacyExtension());
  }
  factories.push(makeAccountProvider()); // must follow pi-privacy — see header

  if (caps.context) {
    const { default: privateerContext } = await import("../../extensions/privateer-context.ts");
    factories.push(privateerContext);
  }

  if (caps.spawnSkills) {
    const { default: privateerSpawnSkills } = await import("../../extensions/privateer-spawn-skills.ts");
    factories.push(privateerSpawnSkills);
  }

  if (opts.relayFiles) {
    const { makeRelayFileTools } = await import("../tools/relayFileTools.ts");
    factories.push(makeRelayFileTools(opts.relayFiles.bridge, opts.relayFiles.attachments));
  }

  if (opts.resultMedia) {
    const { makeAttachResultTools } = await import("../tools/attachResult.ts");
    factories.push(makeAttachResultTools(opts.resultMedia));
  }

  if (caps.web === "account" && webEnabled()) {
    const { makeWebTools } = await import("../tools/web.ts");
    factories.push(makeWebTools());
  } else if (caps.web === "guarded") {
    if (!opts.webHint) throw new Error(`buildMoat: kind "${opts.kind}" needs a webHint for guarded web tools`);
    const hint = opts.webHint;
    const { guardedWebToolDefinitions } = await import("../tools/web.ts");
    factories.push((pi: any) => {
      for (const def of guardedWebToolDefinitions(hint)) pi.registerTool?.(def);
    });
  }

  if (caps.media && mediaEnabled()) {
    const { makeMediaTools } = await import("../tools/media.ts");
    factories.push(makeMediaTools());
  }
  const { makeComposeTools } = await import("../tools/videoCompose.ts");
  factories.push(makeComposeTools());

  if (caps.mcp) {
    // Registers the tools from the shared agent/mcp.json — the same projection the app's
    // MCP manager writes over the relay. No servers configured → a no-op. The specifier is
    // a variable so tsc treats it as Promise<any> and doesn't pull the third-party
    // adapter's own .ts into our typecheck.
    //
    // The caller still owns MCP_DIRECT_TOOLS: the adapter reads it when the factory RUNS
    // (inside createAgentSessionServices), not when it is imported here, so the env has to
    // be set around session creation rather than around this call.
    const mcpAdapterSpec = "pi-mcp-adapter";
    const hostImport = opts.hostImport ?? ((spec: string) => import(spec));
    const { default: mcpAdapter } = await hostImport(mcpAdapterSpec);
    factories.push(mcpAdapter);
  }

  return factories;
}
