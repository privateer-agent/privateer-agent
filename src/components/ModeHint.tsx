import React from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "../config/schema.ts";
import { theme, MODE_COLOR } from "./theme.ts";
import { FAST_FORWARD, PAUSE } from "./figures.ts";
import { useTerminalWidth } from "./useTerminalWidth.ts";

// The footer rendered directly under the prompt box (Claude Code style): the
// active permission mode in its accent color on the left, and a shortcuts hint
// on the right. Default mode is the resting state, so the left side shows
// nothing — but the shortcuts hint always stays pinned to the bottom right.
const MODE_LABEL: Record<PermissionMode, { marker: string; text: string } | null> = {
  default: null,
  acceptEdits: { marker: FAST_FORWARD, text: "accept edits on" },
  bypass: { marker: FAST_FORWARD, text: "bypass permissions on" },
  plan: { marker: PAUSE, text: "plan mode on" },
};

export function ModeHint({ mode, collapsed }: { mode: PermissionMode; collapsed?: boolean }) {
  // Match StatusBar: stay a few columns clear of the right edge so the row never
  // reaches the final column and the terminal never reflows it.
  const width = Math.max(20, useTerminalWidth() - 4);
  const label = MODE_LABEL[mode];
  return (
    <Box width={width} justifyContent="space-between">
      <Box flexShrink={1} minWidth={0}>
        {label && (
          <Text color={MODE_COLOR[mode]} wrap="truncate-end">
            {label.marker} {label.text}
          </Text>
        )}
      </Box>
      <Box flexShrink={0}>
        <Text color={theme.dim} wrap="truncate-end">
          {`/help · esc interrupts · Ctrl+O ${collapsed ? "expand" : "collapse"}`}
        </Text>
      </Box>
    </Box>
  );
}
