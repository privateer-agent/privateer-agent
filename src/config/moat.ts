/**
 * buildMoat() — the one place that decides which extensions a session gets, in what order.
 *
 * WHAT THIS REPLACES. Five entry points each hand-assembled their own `extensionFactories`
 * array: the harbor's sessions (routines, workflows, tasks), its live task spawns, the
 * channels runner, ACP, and the dev REPL. The five lists were the same list — same gate,
 * same privacy extension, same account provider, the same `webEnabled()`/`mediaEnabled()`
 * conditionals — copied with small deliberate differences and a large amount of duplicated
 * comment explaining them. Nothing held them together, so an extension added to one path
 * silently didn't exist on the other four (privateer-media had reached three of five), and
 * the ordering rule below lived as prose repeated in each copy.
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
  | "repl"; // the lean dev REPL (npm run chat)

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
}

/**
 * Per-kind capabilities. `web` and `media` are the CEILING — each is still ANDed with its
 * runtime switch (webEnabled/mediaEnabled), so a false here means "never", not "by default".
 *
 * web is deliberately off for live-task and repl: makeWebTools() routes through the account
 * API precisely because an unattended run must not hold a search provider key, and both of
 * those paths have a human at the other end who can use their own provider (src/tools/web.ts).
 * compose is unconditional everywhere: local ffmpeg work, no account, no network, no spend —
 * so a run with generation off can still assemble media that already exists on disk.
 */
const CAPABILITIES: Record<MoatKind, { web: boolean; media: boolean; mcp: boolean }> = {
  "harbor-session": { web: true, media: true, mcp: true },
  "live-task": { web: false, media: true, mcp: false },
  channels: { web: true, media: true, mcp: false },
  acp: { web: true, media: true, mcp: false },
  repl: { web: false, media: true, mcp: false },
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
  const { privacyExtension } = await import("./privacyPolicy.ts");

  const factories: ExtensionFactory[] = [makePermissionGate(opts.gate)];

  // pi-privacy is configured in exactly ONE place, shared with the DISCOVERED copy of this
  // extension (the TUI's, and every subagent child's) — see ./privacyPolicy.ts for the two
  // bugs that came of configuring it in two.
  factories.push(privacyExtension());
  factories.push(makeAccountProvider()); // must follow pi-privacy — see header

  if (opts.relayFiles) {
    const { makeRelayFileTools } = await import("../tools/relayFileTools.ts");
    factories.push(makeRelayFileTools(opts.relayFiles.bridge, opts.relayFiles.attachments));
  }

  if (opts.resultMedia) {
    const { makeAttachResultTools } = await import("../tools/attachResult.ts");
    factories.push(makeAttachResultTools(opts.resultMedia));
  }

  if (caps.web && webEnabled()) {
    const { makeWebTools } = await import("../tools/web.ts");
    factories.push(makeWebTools());
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
    const { default: mcpAdapter } = await import(mcpAdapterSpec);
    factories.push(mcpAdapter);
  }

  return factories;
}
