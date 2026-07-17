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

import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as priv from "../src/auth/privateer.ts";
import { makeAccountProvider } from "../src/providers/account.ts";
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
              `${p.DIM}   waiting for approval…${p.RESET}`,
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
    dropPersistedAccount(ctx);
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

  // Move the LIVE session onto a confidential model the instant the user signs in. A
  // terminal launched with no credentials is pinned by `--model` to the keyless
  // OpenRouter fallback; without this switch it stays there and the first prompt after
  // sign-in dead-ends on "No API key found for openrouter". resolveSignedInModel picks
  // Tinfoil GLM 5.2 (client-attested TEE) when a key is present, else the account's NEAR
  // channel — private inference that works out of the box. We only override an auto-picked
  // launch model, never a deliberate PRIVATEER_MODEL, and never re-switch if we're already
  // on the target. The account (NEAR) credential is spawned moments AFTER sign-in fires,
  // so setModel can briefly return false ("no key yet"); retry a few times so the switch
  // lands as soon as the credential is ready (Tinfoil, key already in env, succeeds first
  // try). Best-effort throughout — a failure just leaves the launch model in place.
  async function activateSignedInModel(ctx: any): Promise<void> {
    if (process.env.PRIVATEER_MODEL?.trim()) return; // deliberate override — respect it
    const reg = ctx?.modelRegistry;
    if (!reg?.find || typeof pi.setModel !== "function") return;
    const spec = resolveSignedInModel();
    const slash = spec.indexOf("/");
    if (slash <= 0) return;
    const provider = spec.slice(0, slash), id = spec.slice(slash + 1);
    const currentSpec = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
    if (currentSpec === spec) return; // already there — nothing to do
    const model = reg.find(provider, id);
    if (!model) { dbg(`activateSignedInModel: ${spec} not in registry`); return; }
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const ok = await pi.setModel(model);
        if (ok !== false) {
          currentModelProvider = provider;
          refresh(ctx);
          ctx?.ui?.notify?.(`Now using ${spec} for private inference.`, "info");
          dbg(`activateSignedInModel: switched to ${spec}`);
          return;
        }
      } catch (e) {
        dbg(`activateSignedInModel: setModel threw ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 400)); // credential still spawning — retry
    }
    dbg(`activateSignedInModel: gave up switching to ${spec}`);
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
    // refresh on a 401). Mirrors the daemon's shutdown (daemon/index.ts).
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
