// Where the Privateer DESKTOP app lives on this machine, and how to bring it up.
//
// The desktop app and this terminal are two front ends over one home: both read
// ~/.privateer, so they share the account login, the model config, the MCP catalog
// and the per-folder spawn defaults (config/spawns.ts). That makes "open the app"
// a genuinely useful thing for a terminal to offer — nothing is handed over, the
// state is already common — which is what /desktop (extensions/privateer-desktop.ts)
// does, and what the working-line tip in privateer-hints.ts points at.
//
// WHY DETECTION AND NOT JUST A DOWNLOAD LINK. A tip that advertises software the
// user hasn't got is an ad; one that names a command for software they HAVE is
// discoverability. So both consumers ask this module first, and the hint stays
// silent on a machine with no app installed.
//
// NO FOLDER HANDOFF. The app takes no path argument today — its second-instance
// handler just focuses the running window (desktop/src/main/main.mjs) — so /desktop
// opens the app, and the user picks this folder from File ▸ Spawn Privateer at…,
// where the spawn record this terminal already shares makes it start on the same
// model and connectors. If the app ever learns a folder argv, this is the one place
// that has to change.
//
// IMPORT-SAFETY: node builtins only, no Pi imports, no side effects — safe from an
// extension under jiti and from a pre-boot entry alike.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** Per-platform download pages (README ▸ Desktop app). No Linux build exists. */
const DOWNLOAD_MAC = "https://privateer.pro/download/mac";
const DOWNLOAD_MAC_INTEL = "https://privateer.pro/download/mac-intel";
const DOWNLOAD_WINDOWS = "https://privateer.pro/download/windows";

/**
 * The download page to lead with on THIS machine, or null where we ship no desktop
 * build. macOS is split by CPU family — the arm64 dmg won't run on an Intel Mac —
 * and process.arch is the interpreter's answer, not the machine's: an Apple-silicon
 * Mac running a Rosetta node reports x64 and would be led to the Intel build. That
 * is survivable rather than solved (detecting the translation means shelling out to
 * `sysctl sysctl.proc_translated` for one link) because the OTHER build is offered
 * alongside it — see desktopDownloadAltUrl.
 */
export function desktopDownloadUrl(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "darwin") return arch === "x64" ? DOWNLOAD_MAC_INTEL : DOWNLOAD_MAC;
  if (platform === "win32") return DOWNLOAD_WINDOWS;
  return null; // electron-builder.yml targets mac + win only
}

/**
 * The macOS build for the OTHER CPU family, so a Mac user is never one wrong arch
 * away from a download that won't launch. Null everywhere else: Windows ships one
 * x64 installer and there is no Linux build at all.
 */
export function desktopDownloadAltUrl(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform !== "darwin") return null;
  return arch === "x64" ? DOWNLOAD_MAC : DOWNLOAD_MAC_INTEL;
}

/**
 * The installed app, or null. Ordered by confidence:
 *
 *  1. OUR OWN interpreter, when the terminal is running on the app's bundled Node.
 *     The desktop's CLI shim runs `privateer` through the app binary itself with
 *     ELECTRON_RUN_AS_NODE=1 (desktop/src/main/cliShim.mjs), so process.execPath IS
 *     the app — and it's the copy the user actually installed, wherever they put it.
 *  2. The standard install locations. macOS drag-install goes to /Applications or
 *     ~/Applications; the Windows installer is per-user NSIS (perMachine: false) so
 *     %LOCALAPPDATA%\Programs\Privateer is the default, with Program Files covered
 *     for an install that chose it (allowToChangeInstallationDirectory: true).
 *
 * A user who installed somewhere else entirely reads as "not installed" — which
 * costs them a download link they don't need, and never a wrong app launched.
 */
export function desktopAppPath(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  execPath: string = process.execPath,
): string | null {
  const hit = (p: string): string | null => (p && existsSync(p) ? p : null);

  if (platform === "darwin") {
    // …/Privateer.app/Contents/MacOS/Privateer → …/Privateer.app
    const marker = "/Privateer.app/";
    const at = execPath.indexOf(marker);
    if (at >= 0) {
      const bundle = hit(execPath.slice(0, at + marker.length - 1));
      if (bundle) return bundle;
    }
    return hit("/Applications/Privateer.app") ?? hit(join(homedir(), "Applications", "Privateer.app"));
  }

  if (platform === "win32") {
    if (/^privateer\.exe$/i.test(basename(execPath))) {
      const self = hit(execPath);
      if (self) return self;
    }
    const local = env.LOCALAPPDATA;
    const files = env.ProgramFiles;
    return (
      (local ? hit(join(local, "Programs", "Privateer", "Privateer.exe")) : null) ??
      (files ? hit(join(files, "Privateer", "Privateer.exe")) : null)
    );
  }

  return null;
}

/**
 * Launch (or focus) the desktop app. Best-effort and never throws — the caller
 * reports the failure as text, the way openBrowser.ts does.
 *
 * ELECTRON_RUN_AS_NODE IS STRIPPED, and that is load-bearing rather than tidy: when
 * this terminal was itself started by the desktop's CLI shim, that variable is set
 * in our environment, and a child inheriting it starts the app binary as a bare Node
 * that exits without ever drawing a window. `open` goes through LaunchServices and
 * wouldn't pass it on anyway; the Windows path spawns the exe directly and would.
 */
export function openDesktopApp(appPath: string, platform: NodeJS.Platform = process.platform): boolean {
  const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env;
  try {
    const child =
      platform === "darwin"
        ? spawn("open", ["-a", appPath], { detached: true, stdio: "ignore", env })
        : spawn(appPath, [], { detached: true, stdio: "ignore", env });
    child.on("error", () => {}); // a spawn failure must not raise on the event loop
    child.unref(); // never hold the CLI's exit open
    return true;
  } catch {
    return false;
  }
}
