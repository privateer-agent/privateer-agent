// Shared terminal-colour palettes — the one place that decides how Privateer's CLI
// surfaces paint on a light vs dark terminal. Two audiences:
//
//   1. Pi extensions (brand banner, posture badge, remote-access footer) run inside
//      Pi's TUI, which ALREADY auto-detects the terminal background (OSC 11 / COLORFGBG)
//      and picks a light or dark theme. They get a live `Theme` (via ctx.ui.setHeader's
//      factory arg or ctx.ui.theme), so paletteFor(theme) reads the theme's semantic
//      colours — dark ink on a light bg, light ink on a dark bg — instead of a fixed
//      colour. That's the fix for the old "everything painted white → invisible on a
//      white terminal" bug.
//
//   2. The lean standalone REPL (src/cli/chat.ts) runs its OWN readline loop with no Pi
//      TUI and therefore no Theme. It detects the scheme itself from COLORFGBG and picks
//      a matching CliPalette — on a light bg, explicit 256-colour indices that are
//      guaranteed high-contrast (a pale terminal yellow on white is the classic
//      unreadable case), on a dark bg the standard named colours it always used.
//
// IMPORT-SAFETY: this module imports NOTHING (no Pi, no node builtins beyond the ambient
// process global), so it's safe to load from boot-ordered entrypoints — see boot.ts's
// ORDERING CONTRACT. `theme` is typed `any` because the whole extension layer treats Pi
// objects loosely and we don't want a Pi type import here.

// ── SGR primitives ───────────────────────────────────────────────────────────
// 256-color (8-bit), NOT 24-bit truecolor: macOS Terminal.app mangles truecolor. These
// indices are universally supported.
const ESC = "\x1b[";
export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
const c = (n: number): string => `${ESC}38;5;${n}m`;

// ── theme-derived palette (Pi extensions) ────────────────────────────────────
export type Palette = {
  RESET: string;
  BOLD: string;
  INK: string; // primary readable text (wordmark body, version, paths, labels)
  ACCENT: string; // brand accent (marks, highlights, codes, command hints)
  BORDER: string; // frames / box drawing
  DIM: string; // secondary / muted prose
  GREEN: string; // success (connected, verified, context loaded)
  YELLOW: string; // warning (not-signed-in, unconfirmed, update available)
};

// Last-resort palette for when no theme is reachable (headless surfaces have no banner,
// and any Pi new enough to render UI exposes the theme — so this is belt-and-suspenders).
// Kept white so behaviour on a dark terminal is unchanged if the theme lookup ever fails.
export const FALLBACK: Palette = {
  RESET,
  BOLD,
  INK: c(231),
  ACCENT: c(231),
  BORDER: c(231),
  DIM: `${ESC}90m`,
  GREEN: `${ESC}32m`,
  YELLOW: `${ESC}33m`,
};

// Build a Palette from a Pi Theme. getFgAnsi(name) returns the raw SGR foreground escape
// for a theme colour; every lookup falls back to the white default so a theme missing a
// given colour name can never blank a surface.
export function paletteFor(theme: any): Palette {
  if (!theme || typeof theme.getFgAnsi !== "function") return FALLBACK;
  const g = (name: string, fallback: string): string => {
    try {
      const a = theme.getFgAnsi(name);
      return typeof a === "string" && a.length > 0 ? a : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    RESET,
    BOLD,
    INK: g("text", FALLBACK.INK),
    ACCENT: g("accent", FALLBACK.ACCENT),
    BORDER: g("border", FALLBACK.BORDER),
    DIM: g("dim", FALLBACK.DIM),
    GREEN: g("success", FALLBACK.GREEN),
    YELLOW: g("warning", FALLBACK.YELLOW),
  };
}

// ── standalone REPL palette (no Pi Theme) ────────────────────────────────────
export type TerminalScheme = "light" | "dark";

export type CliPalette = {
  RESET: string;
  BOLD: string;
  DIM: string;
  GREEN: string;
  YELLOW: string;
  RED: string;
  CYAN: string; // used as the REPL's accent (prompts, app-relay echoes)
};

// Dark bg: the standard named SGR colours the REPL always used — the terminal maps them
// to its own readable palette.
const CLI_DARK: CliPalette = {
  RESET,
  BOLD,
  DIM: `${ESC}2m`,
  GREEN: `${ESC}32m`,
  YELLOW: `${ESC}33m`,
  RED: `${ESC}31m`,
  CYAN: `${ESC}36m`,
};

// Light bg: explicit dark 256-colour indices so contrast doesn't depend on the terminal's
// ANSI palette (a pale terminal yellow/cyan on white is unreadable; faint `2m` washes
// out). These are all mid-to-dark tones that read cleanly on white.
const CLI_LIGHT: CliPalette = {
  RESET,
  BOLD,
  DIM: c(243), // solid medium gray instead of faint
  GREEN: c(28), // dark green
  YELLOW: c(130), // dark amber (plain 33m is invisible-pale on white)
  RED: c(124), // dark red
  CYAN: c(24), // dark teal-blue accent
};

// Detect the terminal background from COLORFGBG (set by many terminals as "fg;bg", the
// last field being the background ANSI index). 7/15 = light; everything else — or no
// COLORFGBG at all — defaults to dark, matching the REPL's historical assumption.
export function detectScheme(env: Record<string, string | undefined> = process.env): TerminalScheme {
  const fgbg = env.COLORFGBG;
  if (fgbg) {
    const parts = fgbg.split(";");
    const bg = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(bg)) return bg === 7 || bg === 15 ? "light" : "dark";
  }
  return "dark";
}

export function cliPalette(scheme: TerminalScheme = detectScheme()): CliPalette {
  return scheme === "light" ? CLI_LIGHT : CLI_DARK;
}
