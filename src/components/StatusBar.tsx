import React from "react";
import { Box, Text } from "ink";
import { basename } from "node:path";
import { theme, POSTURE_COLOR } from "./theme.ts";
import { SHIELD, DOT } from "./figures.ts";
import { useTerminalWidth } from "./useTerminalWidth.ts";
import { type UsageTotals } from "../engine/events.ts";
import type { ZdrState } from "./useZdrShield.ts";
import type { TeeState } from "./useTeeShield.ts";

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

// TEE shield (NEAR AI / Tinfoil): a colored "⛉ TEE" segment summarizing whether the
// selected model's confidential-inference enclave attested successfully. Dim "⛉ TEE?"
// while loading or when unknown (no key / fetch error); nothing for non-TEE models.
function TeeBadge({ tee }: { tee?: TeeState }) {
  if (!tee || tee.kind === "hidden") return null;
  if (tee.kind === "ready") {
    return <Text color={POSTURE_COLOR[tee.posture]}>{`${SHIELD} TEE · `}</Text>;
  }
  return <Text color={theme.dim}>{`${SHIELD} TEE? · `}</Text>;
}

// Remote-access badge: a green "● remote" segment shown while /remote-access is on,
// signalling the Privateer app can drive this terminal (send prompts / approve its
// tool calls). Nothing at all when remote access is off.
function RemoteBadge({ remote }: { remote?: boolean }) {
  if (!remote) return null;
  return <Text color={theme.success}>{`${DOT} remote · `}</Text>;
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

// Human-readable elapsed time from milliseconds: 8200 → "8s", 83000 → "1m 23s",
// 3723000 → "1h 2m". Drops zero-valued leading units so short turns stay terse.
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// The footer line rendered directly under the prompt box. The headline is a
// Claude-Code-style context-window gauge ("how full is the window right now"),
// not the cumulative billed total — a one-word message barely moves it. The gauge
// sits in a leading bracket so it survives right-edge truncation; model · cwd
// follow and clip first. Cost accounting (cache hits, last-turn / session totals)
// is intentionally not here — it lives in `/context`. The active permission mode
// is shown separately by <ModeHint>.
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
  tee?: TeeState; // TEE attestation posture for the selected model (default line only)
  remote?: boolean; // /remote-access is on — the app can drive this terminal (default line only)
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
  // The bar carries only the context-window gauge ("how full is the window right
  // now") plus model · cwd. The cumulative cost accounting — cache hits, last-turn
  // and session billed totals — lives in `/context`, so the always-on line stays
  // quiet and the live output count belongs to the spinner. See effectiveTokens.
  const diag = formatContext(props.context);
  return (
    <Box marginTop={1} width={width}>
      <Text wrap="truncate-end">
        <ZdrBadge zdr={props.zdr} />
        <TeeBadge tee={props.tee} />
        <RemoteBadge remote={props.remote} />
        <Text color={theme.accent}>⚓ privateer</Text>
        {diag ? <Text color={theme.dim}>{` [${diag}]`}</Text> : null}
        <Text color={theme.dim}> (shift+tab to cycle)</Text>
        <Text color={theme.dim}>
          {` · ${props.modelSpec} · ${basename(props.cwd) || props.cwd}`}
        </Text>
      </Text>
    </Box>
  );
}
