import React from "react";
import { Box, Text } from "ink";
import { basename } from "node:path";
import { theme } from "./theme.ts";
import { useTerminalWidth } from "./useTerminalWidth.ts";

// The footer line rendered directly under the prompt box:
// model · cwd · tokens on the left, a shortcuts hint on the right. The active
// permission mode is shown separately by <ModeHint> below the prompt.
//
// Both sides truncate (never wrap) and the row is bounded a few columns short of
// the terminal so it always stays a single physical line — see useTerminalWidth.
export function StatusBar(props: {
  modelSpec: string;
  cwd: string;
  totalTokens: number;
  custom?: string; // settings-driven status line; overrides the default when set
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
  return (
    <Box marginTop={1} width={width} justifyContent="space-between">
      <Box flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          <Text color={theme.accent}>⚓ privateer</Text>
          <Text color={theme.dim}>
            {` · ${props.modelSpec} · ${basename(props.cwd) || props.cwd} · ${props.totalTokens} tok`}
          </Text>
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={theme.dim} wrap="truncate-end">
          {"  /help · esc interrupts"}
        </Text>
      </Box>
    </Box>
  );
}
