// /desktop — bring up the Privateer desktop app from the terminal.
//
// The two front ends already share everything that matters: one ~/.privateer home,
// so one login, one model config, one MCP catalog, one set of per-folder spawn
// defaults. What was missing was a way across. Getting from a terminal to the app
// meant leaving the terminal — Spotlight, the Dock, a Start-menu hunt — which is
// exactly the kind of small friction that leaves a shipped app unopened.
//
// What it does NOT do is carry the conversation over: the desktop hosts its own
// in-process session and takes no folder argument (see src/config/desktopApp.ts),
// so this opens the app and says how to point a window at the folder you were just
// working in. When the app isn't installed we say so once, with the download page
// for this platform, and never again unasked — the working-line tip in
// privateer-hints.ts only fires on a machine that HAS it.

import {
  desktopAppPath,
  desktopDownloadAltUrl,
  desktopDownloadUrl,
  openDesktopApp,
} from "../src/config/desktopApp.ts";

export default function privateerDesktop(pi: any): void {
  pi.registerCommand?.("desktop", {
    description: "Open the Privateer desktop app — same login, same per-folder defaults",
    handler: (_args: string, ctx: any) => {
      const app = desktopAppPath();

      if (app) {
        const cwd = process.cwd();
        if (openDesktopApp(app)) {
          ctx?.ui?.notify?.(
            `Opening the Privateer desktop app — same login and per-folder defaults as this terminal. ` +
              `File ▸ Spawn Privateer at… points a window at ${cwd}.`,
            "info",
          );
        } else {
          ctx?.ui?.notify?.(`Could not launch ${app} — open it yourself and this terminal keeps working.`, "error");
        }
        return;
      }

      const url = desktopDownloadUrl();
      const alt = desktopDownloadAltUrl(); // the other Mac build — see desktopApp.ts
      ctx?.ui?.notify?.(
        url
          ? `The Privateer desktop app isn't installed here. Download: ${url}${alt ? ` (other Macs: ${alt})` : ""} — ` +
              `it reads the same ~/.privateer, so it starts already signed in with your models and connectors.`
          : `The desktop app ships for macOS and Windows only — on this platform the terminal agent is the app.`,
        "info",
      );
    },
  });
}
