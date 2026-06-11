import React from "react";
import { Box, Text } from "ink";
import { basename } from "node:path";
import { theme, POSTURE_COLOR } from "./theme.ts";
import { SHIELD } from "./figures.ts";
import { useTerminalWidth } from "./useTerminalWidth.ts";
import { effectiveTokens, type UsageTotals } from "../engine/events.ts";
import type { ZdrState } from "./useZdrShield.ts";

// OpenRouter ZDR shield: a colored "⛉ ZDR" segment summarizing the selected model's
// zero-data-retention posture. Dim "⛉ ZDR?" while loading or when the posture is
// unknown (no key / fetch error); nothing at all for non-OpenRouter models.
function ZdrBadge({ zdr }: { zdr?: ZdrState }) {
  if (!zdr || zdr.kind === "hidden") return null;
  if (zdr.kind === "ready") {
    return <Text color={POSTURE_COLOR[zdr.posture]}>{`${SHIELD} ZDR · `}</Text>;
  }
  return <Text color={theme.dim}>{`${SHIELD} ZDR? · `}</Text>;
}

// Compact token count: 100, 1k, 1m, 1b — one decimal place above 1k, trimmed of
// trailing ".0", so 1500 → "1.5k" and 2000 → "2k".
export function formatTokens(n: number): string {
  const units: [number, string][] = [
    [1e9, "b"],
    [1e6, "m"],
    [1e3, "k"],
  ];
  for (const [size, suffix] of units) {
    if (n >= size) return `${(n / size).toFixed(1).replace(/\.0$/, "")}${suffix}`;
  }
  return `${n}`;
}

// The footer line rendered directly under the prompt box. The headline is a
// Claude-Code-style context-window gauge ("how full is the window right now"),
// not the cumulative billed total — a one-word message barely moves it. We pack
// the diagnostics (context %, cache hits, last-turn cost) into a leading bracket
// so they survive right-edge truncation; model · cwd · session follow and clip
// first. The active permission mode is shown separately by <ModeHint>.
//
// Both sides truncate (never wrap) and the row is bounded a few columns short of
// the terminal so it always stays a single physical line — see useTerminalWidth.

// "84k/120k · 70%" when a budget is set, else a bare "84k ctx".
function formatContext(ctx?: { used: number; budget: number }): string {
  if (!ctx) return "";
  if (ctx.budget > 0) {
    const pct = Math.round((ctx.used / ctx.budget) * 100);
    return `${formatTokens(ctx.used)}/${formatTokens(ctx.budget)} · ${pct}%`;
  }
  return `${formatTokens(ctx.used)} ctx`;
}

export function StatusBar(props: {
  modelSpec: string;
  cwd: string;
  usage: UsageTotals;
  context?: { used: number; budget: number };
  lastTurn?: UsageTotals;
  custom?: string; // settings-driven status line; overrides the default when set
  zdr?: ZdrState; // OpenRouter ZDR posture for the selected model (default line only)
}) {
  // Stay clear of the right edge (parent paddingX={1} plus a 2-col safety gap) so
  // the line never reaches the final column and the terminal never reflows it.
  const width = Math.max(20, useTerminalWidth() - 4);
  if (props.custom) {
    return (
      <Box marginTop={1} width={width}>
        <Text color={theme.dim} wrap="truncate-end">
          {props.custom}
        </Text>
      </Box>
    );
  }
  // Diagnostics, billed-weighted so cache hits show their real (discounted) cost
  // rather than the raw re-sent total. See effectiveTokens.
  const cached = formatTokens(props.usage.cachedInputTokens ?? 0);
  const lastTurn = props.lastTurn ? formatTokens(effectiveTokens(props.lastTurn)) : "0";
  const session = formatTokens(effectiveTokens(props.usage));
  const diag = `${formatContext(props.context)} · cached ${cached} · +${lastTurn} last`;
  return (
    <Box marginTop={1} width={width}>
      <Text wrap="truncate-end">
        <ZdrBadge zdr={props.zdr} />
        <Text color={theme.accent}>⚓ privateer</Text>
        <Text color={theme.dim}>{` [${diag}]`}</Text>
        <Text color={theme.dim}> (shift+tab to cycle)</Text>
        <Text color={theme.dim}>
          {` · ${props.modelSpec} · ${basename(props.cwd) || props.cwd} · ${session} session`}
        </Text>
      </Text>
    </Box>
  );
}
