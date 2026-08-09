// `/update` — fetch newer tool packs without leaving the terminal.
//
// A "tool pack" is what Pi calls a package: an npm or git source that contributes
// extensions, skills, prompts or themes (pi-hermes-memory, a private tools repo, …).
// Pi already checked for updates at startup and drew its own yellow box about it. We
// suppress that box (patches/, in interactive-mode's run()) and own the surface here,
// for two reasons:
//
//   1. THE BOX NAMED A COMMAND THAT DOES NOT EXIST. It said "Run pi update --extensions".
//      No `pi` binary is installed on a Privateer machine, and `privateer update` means
//      the CLI's own self-update — so the one instruction on screen either failed with
//      "command not found" or reinstalled the wrong thing. The launcher now routes
//      `privateer update --extensions` properly (bin/privateer-launch.mjs), and in the
//      TUI the answer is simply /update.
//   2. IT WAS THE WRONG SIZE. A warning-bordered box under the banner, for "a pack has a
//      newer version". Privateer's own release notice is a single line INSIDE the banner;
//      packs get a line beside it (extensions/privateer-brand.ts) and nothing more.
//
// WHY THIS CAN HAPPEN LIVE. Nothing here needs a restart, and that is a property of Pi's
// own machinery rather than a trick of ours:
//   - DefaultPackageManager.update() installs into the same on-disk locations the
//     resolver reads from, so the new code is simply *there* when something looks again.
//   - ctx.reload() runs the same path as /reload: resourceLoader.reload() re-runs
//     packageManager.resolve() AND calls clearExtensionCache(), and extensions are loaded
//     through jiti with moduleCache:false — so every extension file is re-read from disk,
//     not served from a module cache. Keybindings, skills, prompts and themes come back
//     with it, and the chat is rebuilt from the session's messages, so scrollback and
//     context survive.
// The honest caveat: in Node (not the bundle) jiti leaves `tryNative` on, so a dependency
// DEEP inside an updated npm pack that Node already loaded natively can stay the old copy
// in memory. The pack's own source always reloads; if something still looks stale after
// an update, a restart is the guaranteed fix, and we say so rather than pretending.
//
// The CLI itself is the one thing that genuinely cannot be swapped live — updating it
// replaces the program that is running — so /update reports it and points at the shell.

import { DefaultPackageManager, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { agentVersion } from "../src/config/version.ts";
import {
  type PackUpdate,
  pendingCliUpdate,
  pendingPackUpdates,
  setPendingPackUpdates,
} from "../src/updates.ts";

// A check costs an npm/git round trip per configured pack. Once at startup is the point;
// the extra checks come from reload (including the one our own /update triggers), where
// re-asking the registry seconds after we already know the answer is pure waste.
const RECHECK_AFTER_MS = 60_000;
let lastCheckedAt = 0;

// Build a package manager against THIS session's cwd and trust decision. Mirrors what
// interactive-mode does for its own startup check: an untrusted project's packages must
// stay out, and trust is the session's answer (ctx.isProjectTrusted), not a fresh guess.
function packageManagerFor(ctx: any): any {
  const cwd = ctx?.cwd ?? process.cwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: ctx?.isProjectTrusted?.() ?? false,
  });
  return new DefaultPackageManager({ cwd, agentDir, settingsManager });
}

async function runCheck(ctx: any, opts: { force?: boolean } = {}): Promise<readonly PackUpdate[]> {
  if (!opts.force && Date.now() - lastCheckedAt < RECHECK_AFTER_MS) return pendingPackUpdates();
  // --offline / PI_OFFLINE means "no startup network", and a registry check is exactly
  // that. Pi's own check bails the same way.
  if (process.env.PI_OFFLINE) return pendingPackUpdates();
  lastCheckedAt = Date.now();
  const updates = await packageManagerFor(ctx).checkForAvailableUpdates();
  const packs: PackUpdate[] = updates.map((u: any) => ({
    source: u.source,
    displayName: u.displayName,
    type: u.type,
    scope: u.scope,
  }));
  setPendingPackUpdates(packs);
  return packs;
}

// "pi-hermes-memory", "pi-hermes-memory and pi-speak", "pi-hermes-memory, pi-speak and 2 more".
function nameList(packs: readonly PackUpdate[]): string {
  const names = packs.map((p) => p.displayName);
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

// The CLI half of "what's out of date", appended to /update's replies so the answer to
// "am I current?" is complete in one place. Null when the CLI is current or unchecked.
function cliNote(): string | null {
  const latest = pendingCliUpdate(agentVersion());
  return latest
    ? `Privateer v${latest} is out too — that one replaces the running program, so run \`privateer update\` from a shell.`
    : null;
}

export default function privateerUpdate(pi: any): void {
  // Check in the background on startup and after a reload. Never on a headless surface
  // (harbor, ACP, print, channels): there's no banner to flag it on and nobody to type
  // /update, so the network call would buy nothing.
  pi.on("session_start", (event: any, ctx: any) => {
    if (!ctx?.hasUI) return;
    if (event?.reason !== "startup" && event?.reason !== "reload") return;
    void runCheck(ctx).catch(() => {
      // Offline, a private registry that won't answer, a git remote behind a VPN — an
      // update check is never worth an error in the user's face. The flag just stays down.
    });
  });

  pi.registerCommand?.("update", {
    description: "Fetch tool pack updates in place: /update [<pack> | check]",
    handler: async (args: string, ctx: any) => {
      const arg = String(args ?? "").trim();
      const notify = (msg: string, kind: "info" | "warning" | "error" = "info") =>
        ctx?.ui?.notify?.(msg, kind);

      if (arg === "check") {
        try {
          const packs = await runCheck(ctx, { force: true });
          const cli = cliNote();
          notify(
            packs.length
              ? `${packs.length} tool pack update${packs.length === 1 ? "" : "s"} ready: ${nameList(packs)} — /update to fetch${cli ? `. ${cli}` : ""}`
              : `Tool packs are current.${cli ? ` ${cli}` : ""}`,
          );
        } catch (err) {
          notify(`Update check failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return;
      }

      // A named pack is passed straight through to the package manager, which matches it
      // against configured sources and reports a better "no such pack" than we could.
      // With no argument we act on what the check found, re-checking first if it never
      // ran (a terminal that started offline, or a pack installed since launch).
      let targets = pendingPackUpdates();
      if (!arg) {
        try {
          targets = await runCheck(ctx, { force: pendingPackUpdates().length === 0 });
        } catch {
          // fall through with whatever the last check knew — update() re-checks anyway.
        }
        if (targets.length === 0) {
          const cli = cliNote();
          notify(`Tool packs are current.${cli ? ` ${cli}` : ""}`);
          return;
        }
      }

      const label = arg || nameList(targets);
      ctx?.ui?.setStatus?.("update", `⚑ updating ${arg || `${targets.length} pack${targets.length === 1 ? "" : "s"}`}`);
      try {
        const pm = packageManagerFor(ctx);
        // Progress goes to the footer, not the transcript: an install emits several
        // events per pack and each one as a notification would bury the chat.
        pm.setProgressCallback((e: any) => {
          if (e?.type === "error") return; // update() throws; the catch below reports it
          ctx?.ui?.setStatus?.("update", `⚑ ${e?.action ?? "update"} ${e?.source ?? ""}`.trimEnd());
        });
        await pm.update(arg || undefined);
        pm.setProgressCallback(undefined);
      } catch (err) {
        ctx?.ui?.setStatus?.("update", undefined);
        notify(`Update failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
      ctx?.ui?.setStatus?.("update", undefined);
      // Whatever was pending is on disk now. Clear the flag before the reload so the
      // banner that comes back is already correct, rather than flying a stale one until
      // the post-reload check answers.
      setPendingPackUpdates([]);
      lastCheckedAt = 0;

      // The reload is refused mid-turn (Pi guards on streaming/compaction), so don't ask
      // for one — say plainly that the new code is on disk and waiting.
      if (ctx?.isIdle?.() === false) {
        notify(`Updated ${label}. Run /reload when this turn finishes to load it.`);
        return;
      }

      notify(`Updated ${label} — reloading.`);
      // ⚠️ ctx is STALE after this line (Pi invalidates it when the runtime is replaced).
      // Nothing may touch it, so this is the last statement in the handler.
      await ctx.reload();
    },
  });
}
