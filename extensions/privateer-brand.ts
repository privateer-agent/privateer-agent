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
// shadow them. /signin drives the Privateer *account* device flow directly — which
// has to exist separately, because the `privateer` inference provider only registers
// once credentials exist, so a first-time user can't reach it through provider auth.
//
// On a successful /signin we hot-register the account provider so privateer/* models
// appear immediately, without a restart.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as priv from "../src/auth/privateer.ts";
import { makeAccountProvider } from "../src/providers/account.ts";

const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.3.0";
  }
})();

// ── palette (Privateer CLI identity: indigo accent + cyan, on dark) ──────────
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
function truecolor(h: string): string {
  const n = parseInt(h.slice(1), 16);
  return `${ESC}38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}
const INDIGO = truecolor("#5c7cfa"); // the single Privateer accent hue
const CYAN = truecolor("#22d3ee"); // on-dark highlight (the welcome mark)
const DIM = `${ESC}90m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;

// Anchor motif in ASCII — the Privateer mark (ring, stock, shank, flukes). Kept to
// width-1 glyphs so the framed banner aligns on every terminal (no wide emoji inside).
const ANCHOR = ["    .-.    ", "    '_'    ", "   --|--   ", "     |     ", "  \\  |  /  ", "   \\_|_/   "];
const ANCHOR_W = 11;

// Visible width = characters after stripping SGR escapes. Everything we render inside
// the box is ASCII or a BMP width-1 symbol, so a plain length is exact here.
function vlen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function shortCwd(): string {
  const cwd = process.cwd();
  const home = homedir();
  return cwd === home || cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd;
}

// The account line under the tagline — three states, ported from tree-cli's Banner:
//  - signed in                              → "connected as <account>"
//  - signed out AND the current model bills to a Privateer account → it can't run
//    until they sign in, so say so plainly (warning)
//  - signed out on their own key            → a quiet tease that /signin adds more
function accountLine(modelProvider?: string): string {
  const u = priv.currentUser();
  if (u) {
    const label = u.email ?? (u.solanaPublicKey ? u.solanaPublicKey.slice(0, 6) + "…" : u.id);
    return `${GREEN}connected${DIM} as ${RESET}${INDIGO}${label}${RESET}`;
  }
  if (modelProvider === "privateer") {
    return `${YELLOW}not signed in · /signin to use this model${RESET}`;
  }
  return `${DIM}not signed in · ${INDIGO}/signin${DIM} to connect your account${RESET}`;
}

// Compose the framed banner: anchor column + text column, inside a rounded accent box.
function renderBanner(width: number, modelProvider?: string): string[] {
  const right = [
    `${BOLD}${CYAN}✻ ${INDIGO}PRIVATEER${RESET}`,
    `${DIM}Chart your own course privately.${RESET}`,
    "",
    accountLine(modelProvider),
    `${DIM}privateer-agent ${INDIGO}v${VERSION}${RESET}`,
    `${INDIGO}${shortCwd()}${RESET}`,
  ];
  // Build the six body rows (anchor + gutter + text).
  const rows = ANCHOR.map((a, i) => `${INDIGO}${a}${RESET}${" ".repeat(2)}${right[i] ?? ""}`);
  const cap = Math.max(20, width - 4); // 2 border cells + 2 padding
  const inner = Math.min(cap, Math.max(...rows.map(vlen)));
  const bar = "─".repeat(inner + 2);
  const out = [`${INDIGO}╭${bar}╮${RESET}`];
  for (const row of rows) {
    const pad = Math.max(0, inner - vlen(row));
    out.push(`${INDIGO}│${RESET} ${row}${" ".repeat(pad)} ${INDIGO}│${RESET}`);
  }
  out.push(`${INDIGO}╰${bar}╯${RESET}`);
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
  const label = u.email ? u.email.split("@")[0] : u.solanaPublicKey ? u.solanaPublicKey.slice(0, 6) + "…" : u.id;
  return `⚓ ${label}`;
}

export default function privateerBrand(pi: any): void {
  let currentModelProvider: string | undefined;
  let ctxRef: any = null;
  let greeted = false;

  const setHeader = (ctx: any) =>
    ctx?.ui?.setHeader?.(() => headerComponent(currentModelProvider));

  const refresh = (ctx: any) => {
    if (!ctx?.hasUI) return;
    setHeader(ctx);
    ctx?.ui?.setStatus?.("account", accountBadge());
  };

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
          const uri = code.verification_uri_complete ?? code.verification_uri ?? "";
          ctx?.ui?.setWidget?.(
            "privateer-signin",
            [
              `${CYAN}⚓ Sign in to Privateer${RESET}`,
              `${DIM}Approve this terminal in the Privateer app:${RESET}`,
              `   code   ${BOLD}${INDIGO}${code.user_code}${RESET}`,
              uri ? `${DIM}   or open ${RESET}${INDIGO}${uri}${RESET}` : "",
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
    if (!priv.hasCredentials() && !greeted) {
      greeted = true;
      ctx?.ui?.notify?.(
        "Not signed in — run /signin to connect your Privateer account (adds hosted models + remote access).",
        "info",
      );
    }
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
