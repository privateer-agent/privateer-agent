// Best-effort "open this URL in the user's default browser", for the sign-in flow.
//
// The device-code login used to only PRINT the verification link and wait; opening
// the browser ourselves turns /login into the one-click authorize flow (the page the
// server sends carries the code in its query string, so the user just clicks
// Authorize — no typing). Everything here is best-effort by design: the printed link
// stays in the widget as the fallback, so a failed or skipped open costs nothing.
//
// Two separate questions, two exports:
//   canOpenBrowser() — SHOULD we try? Decides the widget copy up front ("check the
//     code matches your browser" vs "approve in the Privateer app"), so it must be
//     synchronous and conservative: an SSH session or a display-less Linux box would
//     open the browser on the WRONG machine or not at all.
//   openInBrowser()  — actually try, detached, never throwing. The spawned launcher
//     is unref()'d so a lingering handler can't hold the CLI's event loop open.

import { spawn } from "node:child_process";

export function canOpenBrowser(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.PRIVATEER_NO_BROWSER?.trim()) return false; // explicit escape hatch
  // Remote shell: `open`/`xdg-open` would run on the far machine, not where the
  // user's browser is. SSH_TTY covers interactive sessions; SSH_CONNECTION also
  // survives `ssh host command` and some su/sudo transitions.
  if (env.SSH_TTY || env.SSH_CONNECTION) return false;
  // Headless Linux/BSD: no display server → nothing for xdg-open to hand the URL to.
  if (platform !== "darwin" && platform !== "win32" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

// Only well-formed http(s) URLs are ever handed to a launcher — anything else
// (including a scheme-less server value that slipped past verificationLink) is
// refused rather than "fixed" here, so this can't be talked into opening file:// or
// custom-scheme handlers.
export function browsableUrl(raw: string | undefined): string | undefined {
  const s = (raw ?? "").trim();
  if (!s) return undefined;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

export function openInBrowser(rawUrl: string): Promise<boolean> {
  const url = browsableUrl(rawUrl);
  if (!url) return Promise.resolve(false);

  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    // `start` is a cmd built-in; the empty "" is its window-title slot so the URL
    // isn't eaten as the title. cmd re-parses its arguments, so escape the one URL
    // metacharacter cmd cares about (& splits commands); browsableUrl already
    // guarantees there's no whitespace or quotes to break out with.
    cmd = "cmd";
    args = ["/c", "start", "", url.replace(/&/g, "^&")];
  } else {
    cmd = "xdg-open";
    args = [url];
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.once("error", () => done(false)); // launcher missing (e.g. no xdg-open)
      child.once("exit", (code) => done(code === 0));
      child.unref();
      // Some launchers block until the browser exits; don't make the login widget
      // wait on that — after a beat, assume the hand-off worked.
      setTimeout(() => done(true), 2000).unref?.();
    } catch {
      done(false);
    }
  });
}
