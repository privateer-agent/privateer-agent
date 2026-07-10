// Privateer branding for Pi's TUI + the account (sign-in) surface. Three concerns
// live together here because they share one piece of state — whether this terminal
// is signed in to a Privateer account:
//
//   1. A branded startup header — the anchor mark + "✻ PRIVATEER" wordmark + the
//      "Chart your own course privately." tagline (ported from tree-cli's Banner).
//   2. A live status-bar badge (⚓ account) showing the sign-in state at a glance.
//   3. Sign-in UX — /signin, /signout, and a /privateer hub — which drive the
//      device-code flow the account channel needs.
//
// Pi already owns /login and /logout for PROVIDER auth (and /whoami), so we do NOT
// shadow them. The account provider now registers unconditionally (see
// makeAccountProvider), so Privateer appears under Pi's /login "Use a subscription"
// list and a first-time user CAN sign in through provider auth. /signin remains as a
// friendlier, dedicated shortcut that drives the same account device-code flow
// directly — one obvious command instead of /login → pick a provider.
//
// On a successful /signin we hot-register the account provider so privateer/* models
// appear immediately (the account catalog refreshes to the live listing without a
// restart).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as priv from "../src/auth/privateer.ts";
import { makeAccountProvider } from "../src/providers/account.ts";

const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.3.0";
  }
})();

// ── palette (Privateer "Open Water" ocean-blue brand) ────────────────────────
// 256-color (8-bit), NOT 24-bit truecolor: macOS Terminal.app doesn't support
// truecolor and mangles it (the old indigo/cyan came out green). These indices are
// universally supported. Navy (the logo mark) is too dark to read on a dark terminal,
// so we use the app's ocean blues — the same "Open Water" gradient as the brand.
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const c = (n: number): string => `${ESC}38;5;${n}m`;
const OCEAN = c(39); // ≈ #00afff — primary ocean blue (anchor, wordmark "P")
const OCEAN_LIGHT = c(81); // ≈ #5fd7ff — light sky accent (wordmark, version, path)
const BORDER = c(32); // ≈ #0087d7 — deeper ocean, the frame
const DIM = `${ESC}90m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;

// The Privateer mark in ASCII: a padlock (with keyhole) atop an anchor — "bring your
// own model" meets lock-and-key privacy, echoing the app's anchor+padlock logo. Every
// line is the same visible width (11) so the text column beside it stays aligned.
const ANCHOR = [
  "    .-.    ", // shackle arch
  "   |   |   ", // shackle legs
  "  .-----.  ", // lock body top (the shackle's base)
  "  |  o  |  ", // lock body + keyhole
  "  '--+--'  ", // lock body base, shank exits
  "  /\\ | /\\  ", // stock — arms flare from the shank (each \\ is one backslash)
  "  \\  |  /  ", // arms
  "   \\_|_/   ", // flukes
];

// Visible width = characters after stripping SGR escapes. Everything we render inside
// the box is ASCII or a BMP width-1 symbol, so a plain length is exact here.
function vlen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Strip ESC/C0/C1 control bytes from any value we did NOT author before it lands in a
// render line. Account email/id/pubkey come from the server (via credentials.json),
// the device user_code + verification_uri come off the device-code response, and cwd
// comes from the filesystem — none is guaranteed free of raw escape sequences, which
// would otherwise reach the terminal unsanitized. Our own SGR color codes are added
// AFTER cleaning the untrusted substring, so they're preserved; normal printable text
// (including Unicode) is untouched.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");
function clean(s: unknown): string {
  return String(s ?? "").replace(CONTROL_RE, "");
}

function shortCwd(): string {
  const cwd = process.cwd();
  const home = homedir();
  const path = cwd === home || cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd;
  return clean(path);
}

// The account line under the tagline — three states, ported from tree-cli's Banner:
//  - signed in                              → "connected as <account>"
//  - signed out AND the current model bills to a Privateer account → it can't run
//    until they sign in, so say so plainly (warning)
//  - signed out on their own key            → a quiet tease that /signin adds more
function accountLine(modelProvider?: string): string {
  const u = priv.currentUser();
  if (u) {
    const label = clean(u.email ?? (u.solanaPublicKey ? u.solanaPublicKey.slice(0, 6) + "…" : u.id));
    return `${GREEN}connected${DIM} as ${RESET}${OCEAN_LIGHT}${label}${RESET}`;
  }
  if (modelProvider === "privateer") {
    return `${YELLOW}not signed in · /signin to use this model${RESET}`;
  }
  return `${DIM}not signed in · ${OCEAN_LIGHT}/signin${DIM} to connect your account${RESET}`;
}

// Is dotted version `a` newer than `b`? Plain numeric compare of major.minor.patch —
// enough for our npm releases; anything unparseable sorts as 0 and is treated as older.
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

// The "update available" banner line, or "" when we're current / offline / unchecked.
// Reads the cache the launcher refreshes in the background (see bin/privateer-tui) —
// never fetches here, so the banner stays synchronous and never blocks on the network.
function updateNotice(): string {
  try {
    const home = process.env.PRIVATEER_HOME || join(homedir(), ".privateer");
    const { latest } = JSON.parse(readFileSync(join(home, "update-check.json"), "utf8"));
    if (typeof latest === "string" && isNewer(latest, VERSION)) {
      return `${YELLOW}↑ v${latest} available${DIM} · run ${RESET}${OCEAN_LIGHT}privateer update${RESET}`;
    }
  } catch {
    // no cache yet, unreadable, or malformed — show nothing.
  }
  return "";
}

// Compose the framed banner: anchor column + text column, inside a rounded accent box.
function renderBanner(width: number, modelProvider?: string): string[] {
  // Leading blanks drop the text block so the wordmark sits beside the lock body and
  // the shackle rises above it (one entry per anchor line — 8 total).
  const right = [
    "",
    "",
    `${BOLD}${OCEAN_LIGHT}✻ ${OCEAN}P${OCEAN_LIGHT}RIVATEER${RESET}`,
    `${DIM}Chart your own course privately.${RESET}`,
    "",
    accountLine(modelProvider),
    `${DIM}privateer-agent ${OCEAN_LIGHT}v${VERSION}${RESET}`,
    `${OCEAN_LIGHT}${shortCwd()}${RESET}`,
  ];
  // Build the body rows (anchor + gutter + text). A pending-update notice, if any, gets
  // its own row under the block, indented to sit beneath the text column.
  const rows = ANCHOR.map((a, i) => `${OCEAN}${a}${RESET}  ${right[i] ?? ""}`);
  const notice = updateNotice();
  if (notice) rows.push(`      ${notice}`);
  const cap = Math.max(20, width - 4); // 2 border cells + 2 padding
  const inner = Math.min(cap, Math.max(...rows.map(vlen)));
  const bar = "─".repeat(inner + 2);
  const out = [`${BORDER}╭${bar}╮${RESET}`];
  for (const row of rows) {
    const pad = Math.max(0, inner - vlen(row));
    out.push(`${BORDER}│${RESET} ${row}${" ".repeat(pad)} ${BORDER}│${RESET}`);
  }
  out.push(`${BORDER}╰${bar}╯${RESET}`);
  return out;
}

// A Pi header Component (setHeader factory return). Static banner; captures the model
// provider so the account line reflects the picked model.
function headerComponent(modelProvider?: string) {
  return {
    render: (width: number): string[] => renderBanner(width, modelProvider),
    invalidate() {},
  };
}

// Short account label for the footer badge.
function accountBadge(): string {
  const u = priv.currentUser();
  if (!u) return "⚓ guest";
  const label = clean(u.email ? u.email.split("@")[0] : u.solanaPublicKey ? u.solanaPublicKey.slice(0, 6) + "…" : u.id);
  return `⚓ ${label}`;
}

export default function privateerBrand(pi: any): void {
  let currentModelProvider: string | undefined;
  let ctxRef: any = null;

  const setHeader = (ctx: any) =>
    ctx?.ui?.setHeader?.(() => headerComponent(currentModelProvider));

  const refresh = (ctx: any) => {
    if (!ctx?.hasUI) return;
    setHeader(ctx);
    ctx?.ui?.setStatus?.("account", accountBadge());
  };

  // /update — run the global npm install in a child process and report the outcome via
  // notify (the TUI keeps running the OLD code; npm swaps the global bin's inode in
  // place, so replacing it under us is safe and the new version loads on next launch).
  async function doUpdate(ctx: any): Promise<void> {
    ctx?.ui?.notify?.("Updating Privateer — running npm install -g privateer-agent@latest…", "info");
    try {
      const { execFile } = await import("node:child_process");
      const stderr: string = await new Promise((resolve, reject) => {
        execFile(
          "npm",
          ["install", "-g", "privateer-agent@latest"],
          { timeout: 180_000 },
          (err, _out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(errOut || ""))),
        );
      });
      void stderr;
      ctx?.ui?.notify?.("Updated. Restart `privateer` to run the new version.", "info");
    } catch (e) {
      ctx?.ui?.notify?.(
        `Update failed: ${(e as Error).message || e}. Try manually: npm install -g privateer-agent@latest`,
        "error",
      );
    }
  }

  async function doSignIn(ctx: any): Promise<void> {
    if (priv.hasCredentials()) {
      const u = priv.currentUser();
      return ctx?.ui?.notify?.(
        `Already signed in as ${u?.email ?? u?.id}. Run /signout to switch accounts.`,
        "info",
      );
    }
    ctx?.ui?.notify?.("Connecting to Privateer — requesting a device code…", "info");
    try {
      const user = await priv.runDeviceLogin({
        onCode: (code: any) => {
          const uri = clean(code.verification_uri_complete ?? code.verification_uri ?? "");
          const userCode = clean(code.user_code);
          ctx?.ui?.setWidget?.(
            "privateer-signin",
            [
              `${OCEAN_LIGHT}⚓ Sign in to Privateer${RESET}`,
              `${DIM}Approve this terminal in the Privateer app:${RESET}`,
              `   code   ${BOLD}${OCEAN}${userCode}${RESET}`,
              uri ? `${DIM}   or open ${RESET}${OCEAN_LIGHT}${uri}${RESET}` : "",
              `${DIM}   waiting for approval…${RESET}`,
            ].filter(Boolean),
            { placement: "aboveEditor" },
          );
        },
      });
      ctx?.ui?.setWidget?.("privateer-signin", undefined);
      // Hot-register the account provider so privateer/* models appear without a restart.
      try {
        await makeAccountProvider()(pi);
      } catch {
        /* provider list fetch failed — models appear on next launch */
      }
      refresh(ctx);
      ctx?.ui?.notify?.(`Signed in as ${user.email ?? user.id}. Your Privateer models are ready.`, "info");
    } catch (e) {
      ctx?.ui?.setWidget?.("privateer-signin", undefined);
      ctx?.ui?.notify?.((e as Error).message || "Sign-in failed.", "error");
    }
  }

  async function doSignOut(ctx: any): Promise<void> {
    if (!priv.hasCredentials()) return ctx?.ui?.notify?.("Not signed in.", "info");
    const u = priv.currentUser();
    await priv.logout();
    refresh(ctx);
    ctx?.ui?.notify?.(`Signed out${u?.email ? ` (${u.email})` : ""}. Drop anchor for now.`, "info");
  }

  function showStatus(ctx: any): void {
    const u = priv.currentUser();
    ctx?.ui?.notify?.(
      u
        ? `Signed in to Privateer as ${u.email ?? u.id}.`
        : "Not signed in. Run /signin to connect your Privateer account.",
      "info",
    );
  }

  pi.on("session_start", (_e: any, ctx: any) => {
    ctxRef = ctx;
    currentModelProvider = ctx?.model?.provider ?? currentModelProvider;
    if (!ctx?.hasUI) return; // headless (print/json): no banner or prompts
    ctx?.ui?.setTitle?.("Privateer");
    refresh(ctx);
    // No startup notify here: the banner's account line already surfaces the
    // "not signed in · /signin" prompt, so a second line would just be noise.
  });

  // Keep the header's account line in sync with the picked model (the "this model
  // needs sign-in" state depends on the current provider).
  pi.on("model_select", (e: any, ctx: any) => {
    ctxRef = ctx;
    const next = e?.model?.provider;
    if (next && next !== currentModelProvider) {
      currentModelProvider = next;
      setHeader(ctx);
    }
  });

  // The machine login was invalidated server-side (TTL lapsed or revoked in the app):
  // announce it and reflect it in the badge/header immediately.
  priv.onSessionExpired(() => {
    refresh(ctxRef);
    ctxRef?.ui?.notify?.("Your Privateer session expired. Run /signin to sign back in.", "warning");
  });

  pi.registerCommand?.("update", {
    description: "Update Privateer to the latest release (npm i -g privateer-agent@latest)",
    handler: (_args: string, ctx: any) => doUpdate(ctx),
  });
  pi.registerCommand?.("signin", {
    description: "Sign in to your Privateer account (device-code flow)",
    handler: (_args: string, ctx: any) => doSignIn(ctx),
  });
  pi.registerCommand?.("signout", {
    description: "Sign out of your Privateer account on this terminal",
    handler: (_args: string, ctx: any) => doSignOut(ctx),
  });
  pi.registerCommand?.("privateer", {
    description: "Privateer account: /privateer [status | signin | signout]",
    handler: (args: string, ctx: any) => {
      const sub = String(args ?? "").trim().toLowerCase().split(/\s+/)[0];
      if (sub === "signin" || sub === "login") return doSignIn(ctx);
      if (sub === "signout" || sub === "logout") return doSignOut(ctx);
      return showStatus(ctx);
    },
  });
}
