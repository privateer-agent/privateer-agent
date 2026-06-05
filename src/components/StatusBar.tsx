import React from "react";
import { Box, Text } from "ink";
import { basename } from "node:path";
import type { PermissionMode } from "../config/schema.ts";
import { theme, MODE_COLOR } from "./theme.ts";

// The footer line rendered directly under the prompt box:
// mode · model · cwd · tokens on the left, a shortcuts hint on the right.
export function StatusBar(props: {
  modelSpec: string;
  cwd: string;
  totalTokens: number;
  mode: PermissionMode;
  custom?: string; // settings-driven status line; overrides the default when set
}) {
  if (props.custom) {
    return (
      <Box marginTop={1}>
        <Text color={theme.dim}>{props.custom}</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1} justifyContent="space-between">
      <Box gap={1}>
        <Text color={theme.accent}>⚓ privateer</Text>
        <Text color={MODE_COLOR[props.mode]}>· {props.mode}</Text>
        <Text color={theme.dim}>· {props.modelSpec}</Text>
        <Text color={theme.dim}>· {basename(props.cwd) || props.cwd}</Text>
        <Text color={theme.dim}>· {props.totalTokens} tok</Text>
      </Box>
      <Text color={theme.dim}>/help · esc interrupts</Text>
    </Box>
  );
}
