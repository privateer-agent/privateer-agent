// Privateer branding for Pi's TUI + the account (sign-in) surface. Three concerns
// live together here because they share one piece of state — whether this terminal
// is signed in to a Privateer account:
//
//   1. A branded startup header — the anchor mark + "✻ PRIVATEER" wordmark + the
//      "Chart your own course privately." tagline (ported from tree-cli's Banner).
//   2. A live status-bar badge (⚓ account) showing the sign-in state at a glance.
//   3. Auth UX — /login, /logout, and a /privateer hub — which drive the
//      device-code flow the account channel needs.
//
// ONE vocabulary, deliberately: log in / log out. This file used to avoid shadowing
// Pi's built-in /login and /logout and shipped /signin and /signout alongside them,
// which left the user with two auth vocabularies and — worse — a /logout that did
// not log you out. Pi's /logout only clears Pi's own authStorage; the Privateer
// machine login lives in ~/.privateer/credentials.json and survived it, so /logout
// on a signed-in machine reported "No stored credentials to remove" and changed
// nothing. We now own both verbs: /logout here is canonical and Pi's built-in is
// redirected to it (patches/, same mechanism as the /model → /models redirect).
// /signin and /signout stay as undocumented aliases for muscle memory.
//
// The account provider also registers unconditionally (see makeAccountProvider), so
// Privateer appears under Pi's "Use a subscription" list and a first-time user can
// log in that way too. On a successful login we hot-register the account provider so
// privateer/* models appear immediately (the account catalog refreshes to the live
// listing without a restart).

import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as priv from "../src/auth/privateer.ts";
import { armAccountCredential, makeAccountProvider } from "../src/providers/account.ts";
import { resolveSignedInModel } from "../src/providers/defaultModel.ts";
import { discoverContextFiles, onContextChanged } from "../src/context.ts";
import { type Palette, paletteFor } from "../src/ui/palette.ts";

const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.3.0";
  }
})();

// The banner paints from Pi's ACTIVE theme (paletteFor, in src/ui/palette.ts) rather
// than a fixed colour. It used to hardcode everything to white (256-color 231) "because
// navy is too dark on a dark terminal" — which inverts the problem on a LIGHT terminal
// (white-on-white → the whole mark, wordmark, and frame vanish). Pi auto-detects the
// terminal background and picks a light or dark theme; ctx.ui.setHeader hands our factory
// that live Theme (and ctx.ui.theme exposes it to the sign-in widget), so the banner's
// colours resolve to dark ink on a light bg and light ink on a dark bg.

// The Privateer mark: our symbol — a padlock (with a keyhole) fused into an anchor,
// "bring your own model" meets lock-and-key privacy — drawn from the app's logo. It's
// rendered with terminal HALF-BLOCKS, so each text row packs TWO pixel rows. The mark is
// a SINGLE colour (every set pixel is the accent), so a cell never needs two different
// colours: both pixels set → a full block "█", top only → "▀", bottom only → "▄", none →
// a space — all painted with the accent as FOREGROUND, no background cells at all. That
// makes the mark inherit the theme's ink (dark on light, light on dark) with one colour,
// and sidesteps the old bg-bleed hazard entirely. Every built line is MARK_W visible
// cells wide (SGR escapes don't count), so the text column beside it stays aligned. To
// redraw: edit PIXELS (each char is "O" ink or "." transparent), keeping every row MARK_W
// long and the row COUNT even — the builder pairs rows into half-block cells.
const MARK_W = 12;
// 12 wide; an EVEN number of rows so they pair cleanly into half-block cells. Two blank
// leading rows give the lock a little headroom without dropping the whole mark too low.
// A small padlock rides on top as the anchor's ring: a narrow rounded shackle over an
// 8-wide body that OVERHANGS the shackle on both sides (matching the logo's proportions,
// where the body is clearly wider than the shackle), with a small centered 2×2 keyhole
// knocked out of it — reads clearly as a lock without dominating the anchor. Then a short
// shank → hooked fluke barbs (a 2-tall blade tip that turns up-and-out) → crown → bill.
const PIXELS = [
  "............", "............",
  "....OOOO....", "...OO..OO...", "...OO..OO...",
  "..OOOOOOOO..", "..OOOOOOOO..",
  "..OOO..OOO..", "..OOO..OOO..",
  "..OOOOOOOO..", "..OOOOOOOO..",
  ".....OO.....", ".....OO.....",
  "O....OO....O", "OO...OO...OO", "OO...OO...OO",
  ".OO..OO..OO.", "..OO.OO.OO..",
  "..OOOOOOOO..", "...OOOOOO...", "....OOOO....", ".....OO.....",
];
// Build the mark for a given palette (the accent is the ink). Cheap — called once per
// header factory invocation, i.e. once per theme, not per frame. Each cell resets SGR so
// the accent can never bleed into the row padding the framer adds after it.
function buildMark(p: Palette): string[] {
  const rows: string[] = [];
  for (let r = 0; r < PIXELS.length; r += 2) {
    const top = PIXELS[r];
    const bot = PIXELS[r + 1] ?? ".".repeat(MARK_W);
    let line = "";
    for (let x = 0; x < MARK_W; x++) {
      const t = top[x] === "O";
      const b = bot[x] === "O";
      if (t && b) line += `${p.ACCENT}█${p.RESET}`;
      else if (t) line += `${p.ACCENT}▀${p.RESET}`;
      else if (b) line += `${p.ACCENT}▄${p.RESET}`;
      else line += " ";
    }
    rows.push(line);
  }
  return rows;
}

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

// Collapse $HOME to ~ in an absolute path, and strip control bytes (paths come off the
// filesystem). Shared by the cwd line and the PRIVATEER.md line.
function shortPath(p: string): string {
  const home = homedir();
  const short = p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
  return clean(short);
}

function shortCwd(): string {
  return shortPath(process.cwd());
}

// The account line under the tagline — three states, ported from tree-cli's Banner:
//  - signed in                              → "connected as <account>"
//  - signed out AND the current model bills to a Privateer account → it can't run
//    until they sign in, so say so plainly (warning)
//  - signed out on their own key            → a quiet tease that /login adds more
function accountLine(p: Palette, modelProvider?: string): string {
  const u = priv.currentUser();
  if (u) {
    const label = clean(u.email ?? (u.solanaPublicKey ? u.solanaPublicKey.slice(0, 6) + "…" : u.id));
    return `${p.GREEN}connected${p.DIM} as ${p.RESET}${p.INK}${label}${p.RESET}`;
  }
  if (modelProvider === "privateer") {
    return `${p.YELLOW}not signed in · /login to use this model${p.RESET}`;
  }
  return `${p.DIM}not signed in · ${p.INK}/login${p.DIM} to connect your account${p.RESET}`;
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
function updateNotice(p: Palette): string {
  try {
    const home = process.env.PRIVATEER_HOME || join(homedir(), ".privateer");
    const { latest } = JSON.parse(readFileSync(join(home, "update-check.json"), "utf8"));
    if (typeof latest === "string" && isNewer(latest, VERSION)) {
      return `${p.YELLOW}↑ v${latest} available${p.DIM} · run ${p.RESET}${p.INK}privateer update${p.RESET}`;
    }
  } catch {
    // no cache yet, unreadable, or malformed — show nothing.
  }
  return "";
}

// The PRIVATEER.md line under the block: green anchor when a project-context file is
// loaded (so the moat's "the agent knows this project" state is visible), otherwise a
// quiet tease that /init scaffolds one. Reads the filesystem at render time, so it
// reflects the current cwd and updates after /init (via onContextChanged → refresh).
function contextLine(p: Palette): string {
  const files = discoverContextFiles();
  if (files.length === 0) {
    return `${p.DIM}no PRIVATEER.md · ${p.INK}/init${p.DIM} to add project context${p.RESET}`;
  }
  // Show the nearest (deepest, wins-last) file's path; note any additional ancestors
  // with a "+N" so the header stays one line but the count isn't hidden.
  const nearest = shortPath(files[files.length - 1].path);
  const more = files.length > 1 ? `${p.DIM} +${files.length - 1}${p.RESET}` : "";
  return `${p.GREEN}⚓${p.DIM} ${p.RESET}${p.INK}${nearest}${p.RESET}${more}`;
}

// ── "What's New" — a tiny in-banner changelog ────────────────────────────────
// A hand-curated highlights list (newest first). Not the full changelog — just the two
// or three things a returning user should notice. `cmd`, when present, is rendered in the
// accent color so the actionable bit stands out from the prose. Trim this as it ages.
const WHATS_NEW: Array<{ text: string; cmd?: string }> = [
  { text: "Privateer agent CLI is live —", cmd: "npm i -g privateer-agent" },
  { text: "PRIVATEER.md project context —", cmd: "/init" },
  { text: "Self-update built in —", cmd: "privateer update" },
];

function whatsNewRows(p: Palette): string[] {
  const head = `${p.BOLD}${p.INK}✦ What's new${p.RESET}`;
  const items = WHATS_NEW.map(
    ({ text, cmd }) =>
      `${p.ACCENT}·${p.RESET} ${p.DIM}${text}${p.RESET}${cmd ? ` ${p.INK}${cmd}${p.RESET}` : ""}`,
  );
  return [head, ...items];
}

// Compose the framed banner: the mark on the left, an independent text column on the
// right. The two columns have DIFFERENT heights (the text runs longer than the 6-line
// mark), so we zip by row index and pad the short side — every text-only row lands in
// the same column as the rows beside the mark. One place owns the left gutter, so
// spacing can't drift between the mark rows and the trailing rows.
function renderBanner(width: number, p: Palette, mark: string[], modelProvider?: string): string[] {
  // Right column, top to bottom. The two leading blanks drop the wordmark down so it
  // sits beside the lock body (not the shackle); the rest follows in reading order.
  const text: string[] = [
    "",
    `${p.BOLD}${p.ACCENT}✻ ${p.ACCENT}P${p.INK}RIVATEER${p.RESET}${p.DIM}   privateer-agent ${p.INK}v${VERSION}${p.RESET}`,
    `${p.DIM}Chart your own course privately.${p.RESET}`,
    "",
    accountLine(p, modelProvider),
    `${p.INK}${shortCwd()}${p.RESET}`,
    contextLine(p),
  ];
  const notice = updateNotice(p);
  if (notice) text.push(notice);
  // A blank spacer, then the What's New block — set off below the identity lines.
  text.push("", ...whatsNewRows(p));

  // Zip the mark and the text column by row. Rows past the mark's height get a blank
  // gutter of the mark's width, so the text stays in one column throughout.
  const gap = "  ";
  const height = Math.max(mark.length, text.length);
  const rows: string[] = [];
  for (let i = 0; i < height; i++) {
    // The mark lines already carry their own per-pixel colors, so we don't wrap them.
    const left = i < mark.length ? mark[i] : " ".repeat(MARK_W);
    rows.push(`${left}${gap}${text[i] ?? ""}`.trimEnd());
  }

  const cap = Math.max(20, width - 4); // 2 border cells + 2 padding
  const inner = Math.min(cap, Math.max(...rows.map(vlen)));
  const bar = "─".repeat(inner + 2);
  const out = [`${p.BORDER}╭${bar}╮${p.RESET}`];
  for (const row of rows) {
    const pad = Math.max(0, inner - vlen(row));
    out.push(`${p.BORDER}│${p.RESET} ${row}${" ".repeat(pad)} ${p.BORDER}│${p.RESET}`);
  }
  out.push(`${p.BORDER}╰${bar}╯${p.RESET}`);
  return out;
}

// A Pi header Component (setHeader factory return). Static banner; captures the model
// provider so the account line reflects the picked model, and the live theme so every
// colour tracks the terminal background (dark ink on light, light ink on dark). The
// palette and mark are resolved once here (per theme), not per frame.
function headerComponent(theme: any, modelProvider?: string) {
  const p = paletteFor(theme);
  const mark = buildMark(p);
  return {
    render: (width: number): string[] => renderBanner(width, p, mark, modelProvider),
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

  // TEMP debug trace (PRIVATEER_DEBUG=1): append a line to ~/.privateer/brand-debug.log
  // so we can see, from a real sign-in, whether the refresh path fires and with what state.
  const dbg = (msg: string): void => {
    if (!process.env.PRIVATEER_DEBUG) return;
    try {
      const home = process.env.PRIVATEER_HOME || join(homedir(), ".privateer");
      appendFileSync(join(home, "brand-debug.log"), `${new Date().toISOString()} ${msg}\n`);
    } catch {
      /* best effort */
    }
  };

  // Pi calls the factory with (tui, theme) — pass the live theme through so the banner
  // paints from it. Falls back to ctx.ui.theme when a Pi build hands the factory no theme.
  const setHeader = (ctx: any) =>
    ctx?.ui?.setHeader?.((_tui: any, theme: any) =>
      headerComponent(theme ?? ctx?.ui?.theme, currentModelProvider),
    );

  const refresh = (ctx: any) => {
    dbg(`refresh: hasUI=${!!ctx?.hasUI} hasSetHeader=${typeof ctx?.ui?.setHeader} user=${priv.currentUser()?.email ?? null}`);
    if (!ctx?.hasUI) return;
    setHeader(ctx);
    ctx?.ui?.setStatus?.("account", accountBadge());
  };

  // Drop Pi's PERSISTED account credential (the "privateer" entry in auth.json).
  // Pi reuses this credential on the next launch and refreshes it only when it
  // EXPIRES — never reactively on a 401 (see the LIFECYCLE HAZARD note in
  // src/auth/privateer.ts). So whenever the machine login goes away — an explicit
  // /signout, or a revocation/expiry we detect server-side — we MUST also drop this
  // persisted copy, or the next run reuses a token that's already dead server-side
  // and dead-ends on the first inference. Removing it makes the next /signin spawn a
  // fresh session. Reached via the model registry (constructed with the auth
  // storage; see session.ts). Best-effort: nothing persisted → nothing to do.
  const dropPersistedAccount = (ctx: any): void => {
    try {
      ctx?.modelRegistry?.authStorage?.remove?.("privateer");
    } catch {
      /* no persisted credential / older Pi without this shape — nothing to do */
    }
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

  // /login. Signing in must leave the terminal ABLE TO PROMPT, not merely "connected" —
  // so this runs the device flow, hot-registers the account provider, then hands off to
  // activateSignedInModel to arm the channel and select the model. Every step reports.
  async function doSignIn(ctx: any): Promise<void> {
    if (priv.hasCredentials()) {
      const u = priv.currentUser();
      // Already linked: still make sure THIS session can use the account (a terminal
      // launched before the login, or one whose channel never armed, otherwise sits
      // "signed in" and unusable), then point at the two things they might have meant.
      await activateSignedInModel(ctx, { switchModel: false });
      return ctx?.ui?.notify?.(
        `Signed in as ${u?.email ?? u?.id}. Run /logout to switch accounts, or /login keys to add a provider API key.`,
        "info",
      );
    }
    ctx?.ui?.notify?.("Connecting to Privateer — requesting a device code…", "info");
    try {
      const p = paletteFor(ctx?.ui?.theme);
      const user = await priv.runDeviceLogin({
        onCode: (code: any) => {
          const uri = clean(code.verification_uri_complete ?? code.verification_uri ?? "");
          const userCode = clean(code.user_code);
          ctx?.ui?.setWidget?.(
            "privateer-signin",
            [
              `${p.INK}⚓ Sign in to Privateer${p.RESET}`,
              `${p.DIM}Approve this terminal in the Privateer app:${p.RESET}`,
              `   code   ${p.BOLD}${p.ACCENT}${userCode}${p.RESET}`,
              uri ? `${p.DIM}   or open ${p.RESET}${p.INK}${uri}${p.RESET}` : "",
              `${p.DIM}   waiting for approval… ${p.RESET}${p.DIM}(esc to cancel · ${p.RESET}${p.INK}/login keys${p.DIM} to use your own API key instead)${p.RESET}`,
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
      ctx?.ui?.notify?.(`Signed in as ${user.email ?? user.id}.`, "info");
      // Arm the account channel and select the model, IN THIS SESSION. runDeviceLogin
      // fires onSignedIn too, which does the same work — this await is what makes the
      // outcome (and any failure) land before we hand the prompt back to the user.
      await activateSignedInModel(ctx);
    } catch (e) {
      ctx?.ui?.setWidget?.("privateer-signin", undefined);
      ctx?.ui?.notify?.((e as Error).message || "Sign-in failed.", "error");
    }
  }

  // Log out of this MACHINE — the login and every terminal spawned from it (see
  // priv.logout). Unlike the old terminal-scoped sign-out this makes a blocking
  // network call, so say what's happening before the round trip rather than after.
  async function doSignOut(ctx: any): Promise<void> {
    if (!priv.hasCredentials()) return ctx?.ui?.notify?.("Not signed in.", "info");
    const u = priv.currentUser();
    ctx?.ui?.notify?.("Signing out of Privateer…", "info");
    await priv.logout(); // never throws: local state is wiped whatever the network did
    dropPersistedAccount(ctx);
    refresh(ctx);
    ctx?.ui?.notify?.(
      `Signed out${u?.email ? ` (${u.email})` : ""} — this machine and its terminals. Drop anchor for now.`,
      "info",
    );
  }

  function showStatus(ctx: any): void {
    const u = priv.currentUser();
    ctx?.ui?.notify?.(
      u
        ? `Signed in to Privateer as ${u.email ?? u.id}.`
        : "Not logged in. Run /login to connect your Privateer account.",
      "info",
    );
  }

  // Make the terminal USABLE the instant the user signs in — the whole point of
  // logging in, and the step that used to be missing. Two halves, in this order:
  //
  //   1. ARM the account channel. Pi stores an OAuth credential only for a login it
  //      drove itself, so after our own device-code /login the `privateer` provider has
  //      no key at all. Arming first also matters for the now-common case where the
  //      launch model ALREADY is the account model (a signed-out terminal boots on it,
  //      see providers/defaultModel.ts): there's no switch to make, only a key to fetch,
  //      and the old early-return skipped it and left the next prompt to fail.
  //   2. SWITCH the live model, if we aren't already on it. A terminal that launched on
  //      a BYO key stays on that key otherwise, so signing in appears to do nothing.
  //
  // resolveSignedInModel picks Tinfoil GLM 5.2 — direct (client-attested) when a Tinfoil
  // key is present, over the subscription otherwise. A deliberate PRIVATEER_MODEL is
  // never overridden. Idempotent: sign-in fires this twice by design (once when
  // credentials land, once when the channel is ready), and a second run is a no-op.
  // Best-effort — but a failure is now REPORTED, because silently leaving the user on an
  // unusable model is exactly the bug this replaces.
  let activating = false;
  async function activateSignedInModel(ctx: any, opts: { switchModel?: boolean } = {}): Promise<void> {
    if (activating || process.env.PRIVATEER_MODEL?.trim()) return; // in-flight, or a deliberate override
    activating = true;
    try {
      const spec = resolveSignedInModel();
      const slash = spec.indexOf("/");
      if (slash <= 0) return;
      const provider = spec.slice(0, slash), id = spec.slice(slash + 1);

      // The account channel needs a live session token before any privateer/* model can
      // run. Retry briefly: this can be racing the credential the login itself minted.
      if (provider === "privateer") {
        let armed = false;
        for (let attempt = 0; attempt < 3 && !armed; attempt++) {
          armed = await armAccountCredential(ctx, { notify: false });
          if (!armed) await new Promise((r) => setTimeout(r, 500));
        }
        if (!armed) {
          dbg("activateSignedInModel: account channel not armed");
          ctx?.ui?.notify?.(
            "Signed in, but this terminal couldn't open an account session. Check your connection and run /login again, or sign a terminal out in the app if you're at the device limit.",
            "error",
          );
          return;
        }
      }

      // Re-running /login while already signed in arms the channel but must NOT move the
      // user off a model they picked with /models. Only a genuine sign-in switches.
      if (opts.switchModel === false) return;

      // Already on the target — the common case now that a signed-out terminal launches
      // on the account model. Nothing to switch, but SAY so: the channel just went live
      // under them, and silence after a login is what made the old flow feel broken.
      const currentSpec = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
      if (currentSpec === spec) {
        dbg(`activateSignedInModel: already on ${spec}`);
        refresh(ctx);
        ctx?.ui?.notify?.(`${spec} is ready — private inference on your Privateer account.`, "info");
        return;
      }

      const reg = ctx?.modelRegistry;
      if (!reg?.find || typeof pi.setModel !== "function") return;
      const model = reg.find(provider, id);
      if (!model) {
        // The provider's live catalog may still be loading (or this is the first sign-in
        // of the run, before the account provider was registered). Say something useful
        // rather than stranding them on a model their account can't bill.
        dbg(`activateSignedInModel: ${spec} not in registry`);
        ctx?.ui?.notify?.(`Signed in. Run /models to pick a model — ${spec} isn't loaded yet.`, "warning");
        return;
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const ok = await pi.setModel(model);
          if (ok !== false) {
            currentModelProvider = provider;
            refresh(ctx);
            ctx?.ui?.notify?.(`Now using ${spec} — private inference on your Privateer account.`, "info");
            dbg(`activateSignedInModel: switched to ${spec}`);
            return;
          }
        } catch (e) {
          dbg(`activateSignedInModel: setModel threw ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 400)); // registry still settling — retry
      }
      dbg(`activateSignedInModel: gave up switching to ${spec}`);
      ctx?.ui?.notify?.(`Signed in, but couldn't switch to ${spec}. Run /models to pick one.`, "warning");
    } finally {
      activating = false;
    }
  }

  dbg("extension loaded, onSignedIn listener registering");

  pi.on("session_start", (_e: any, ctx: any) => {
    dbg("session_start");
    ctxRef = ctx;
    currentModelProvider = ctx?.model?.provider ?? currentModelProvider;

    // Validate the machine login against the server at launch. The banner/badge
    // otherwise reflect ONLY local credentials.json, so a terminal that was signed
    // out from the app (or whose login expired) keeps showing "connected as …"
    // indefinitely — nothing else spawns a session at startup (Pi reuses its
    // persisted account credential and refreshes it only on expiry, not on a 401).
    // warmSession spawns this terminal's child session from the parent refresh
    // token; if that token was revoked/expired the server 401s, which clears the
    // local credentials and fires onSessionExpired — flipping the banner to "not
    // signed in" right here at launch instead of dead-ending on the first prompt.
    // Fire-and-forget: warmSession swallows transient errors, and the
    // onSessionExpired handler below owns the UI update.
    void priv.warmSession();

    if (!ctx?.hasUI) return; // headless (print/json): no banner or prompts
    ctx?.ui?.setTitle?.("Privateer");
    refresh(ctx);
    // No startup notify here: the banner's account line already surfaces the
    // "not signed in · /login" prompt, so a second line would just be noise.
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

  // A machine login was newly established. This fires for BOTH sign-in paths — our
  // /signin command AND Pi's /login → "Use a subscription" OAuth flow. doSignIn
  // already refreshes itself, but a /login sign-in has no other hook back to us, so
  // without this the header/badge would keep showing "not signed in" until relaunch.
  priv.onSignedIn(() => {
    dbg(`onSignedIn fired; ctxRef=${ctxRef ? "set" : "null"}`);
    refresh(ctxRef);
    // Activate a confidential model in the live session so the user can prompt right
    // away instead of dead-ending on the keyless launch model. See activateSignedInModel.
    void activateSignedInModel(ctxRef);
  });

  // /init (in privateer-context) just created or changed a PRIVATEER.md — re-render the
  // banner so its context line flips from the "/init" hint to "PRIVATEER.md loaded".
  onContextChanged(() => refresh(ctxRef));

  // The terminal is quitting (Ctrl+C, Ctrl+D, /quit, SIGTERM …). Pi awaits this
  // handler inside runtimeHost.dispose() BEFORE process.exit, so it's our one
  // reliable window to revoke the server-side sessions this run created — the
  // account channel Pi drives AND any child session — so the terminal drops off the
  // app's Linked Devices list immediately instead of lingering until the rows expire.
  // Only on "quit": the other reasons (new/resume/fork/reload) keep this process
  // alive and reuse the same account credential, so revoking would kill a live session.
  // Best-effort and time-bounded (see revokeLocalSessions); exit must never hang.
  pi.on("session_shutdown", async (e: any) => {
    if (e?.reason && e.reason !== "quit") return;
    await priv.revokeLocalSessions();
    // Pair the revoke with dropping Pi's persisted account credential (the contract
    // in src/auth/privateer.ts): revokeLocalSessions kills the account session
    // server-side, so leaving the persisted copy behind would make the NEXT launch
    // reuse a token that's already dead and dead-end on its first prompt (Pi doesn't
    // refresh on a 401). Mirrors the harbor's shutdown (harbor/index.ts).
    dropPersistedAccount(ctxRef);
  });

  // The machine login was invalidated server-side (TTL lapsed or revoked in the app):
  // announce it and reflect it in the badge/header immediately.
  priv.onSessionExpired(() => {
    // clearCredentials() has already wiped the local machine login; also drop Pi's
    // persisted account credential so the next prompt/launch doesn't reuse a token
    // that's now dead server-side (see dropPersistedAccount).
    dropPersistedAccount(ctxRef);
    refresh(ctxRef);
    ctxRef?.ui?.notify?.("Your Privateer session expired. Run /login to sign back in.", "warning");
  });

  pi.registerCommand?.("update", {
    description: "Update Privateer to the latest release (npm i -g privateer-agent@latest)",
    handler: (_args: string, ctx: any) => doUpdate(ctx),
  });
  // ONE vocabulary: log in / log out. Pi's own built-ins are /login and /logout, so
  // matching them is what makes the pair feel like a single concept instead of two
  // half-overlapping ones (Pi's /logout used to clear only Pi's authStorage while the
  // machine login lived on, which read as "logout doesn't work"). doSignIn/doSignOut
  // are canonical; patches/ redirects Pi's built-ins to `/privateer login|logout`
  // rather than to these registrations, so the redirect can't re-enter the branch it
  // was dispatched from — the same mechanism as the /model → /models redirect.
  //
  // In interactive mode that redirect means the built-in wins and these two never
  // dispatch (patches/ also silences the resulting conflict warning). They stay
  // registered for rpc/print mode, which has no such redirect and reaches them by name.
  //
  // signin/signout stay registered as undocumented aliases — they were the shipped
  // names, they're in muscle memory and in older docs, and an alias costs nothing.
  pi.registerCommand?.("login", {
    description: "Log in to your Privateer account · /login keys for a provider API key",
    handler: (_args: string, ctx: any) => doSignIn(ctx),
  });
  pi.registerCommand?.("logout", {
    description: "Log out of Privateer on this machine (revokes all its terminals)",
    handler: (_args: string, ctx: any) => doSignOut(ctx),
  });
  pi.registerCommand?.("signin", { description: "", handler: (_a: string, ctx: any) => doSignIn(ctx) });
  pi.registerCommand?.("signout", { description: "", handler: (_a: string, ctx: any) => doSignOut(ctx) });
  pi.registerCommand?.("privateer", {
    description: "Privateer account: /privateer [status | login | logout]",
    handler: (args: string, ctx: any) => {
      const sub = String(args ?? "").trim().toLowerCase().split(/\s+/)[0];
      if (sub === "login" || sub === "signin") return doSignIn(ctx);
      if (sub === "logout" || sub === "signout") return doSignOut(ctx);
      return showStatus(ctx);
    },
  });
}
