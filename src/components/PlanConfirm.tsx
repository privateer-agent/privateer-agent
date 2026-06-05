import React from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.ts";

// Shown after a turn completes while in plan mode: the agent has presented a plan,
// and the user chooses to approve (leave plan mode) or keep planning.
export function PlanConfirm({ onApprove, onKeep }: { onApprove: () => void; onKeep: () => void }) {
  useInput((input, key) => {
    if (input === "a" || key.return) onApprove();
    else if (input === "k" || key.escape) onKeep();
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent}>Plan ready — review it above.</Text>
      <Text>
        <Text color={theme.accent}>a</Text>
        <Text color={theme.dim}> approve & exit plan mode</Text>
        <Text color={theme.dim}>{"   "}</Text>
        <Text color={theme.accent}>k</Text>
        <Text color={theme.dim}> keep planning</Text>
      </Text>
    </Box>
  );
}
