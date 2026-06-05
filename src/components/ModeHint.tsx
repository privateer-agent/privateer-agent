import React from "react";
import { Box, Text } from "ink";
import type { PermissionMode } from "../config/schema.ts";
import { MODE_COLOR } from "./theme.ts";
import { FAST_FORWARD, PAUSE } from "./figures.ts";

// The line rendered directly under the prompt box (Claude Code style): the active
// permission mode in its accent color. Default mode is the resting state, so it
// shows nothing.
const MODE_LABEL: Record<PermissionMode, { marker: string; text: string } | null> = {
  default: null,
  acceptEdits: { marker: FAST_FORWARD, text: "accept edits on" },
  bypass: { marker: FAST_FORWARD, text: "bypass permissions on" },
  plan: { marker: PAUSE, text: "plan mode on" },
};

export function ModeHint({ mode }: { mode: PermissionMode }) {
  const label = MODE_LABEL[mode];
  if (!label) return null;
  return (
    <Box paddingX={1}>
      <Text color={MODE_COLOR[mode]} wrap="truncate-end">
        {label.marker} {label.text}
      </Text>
    </Box>
  );
}
