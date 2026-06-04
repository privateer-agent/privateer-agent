import React from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionRequest } from "../permissions/gate.ts";
import type { AskOutcome } from "../permissions/uiGate.ts";
import { theme } from "./theme.ts";

// Interactive approval shown when a tool needs permission. Keys: y allow once,
// a allow always, n / esc deny.
export function ApprovalPrompt({
  req,
  onRespond,
}: {
  req: PermissionRequest;
  onRespond: (outcome: AskOutcome) => void;
}) {
  useInput((input, key) => {
    const c = input.toLowerCase();
    if (c === "y") onRespond("allow");
    else if (c === "a") onRespond("always");
    else if (c === "n" || key.escape) onRespond("deny");
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.warning} paddingX={1}>
      <Text>
        <Text bold color={theme.warning}>
          {req.title}
        </Text>
        <Text dimColor> ({req.tool})</Text>
      </Text>
      <Text>{req.detail}</Text>
      <Text dimColor>
        <Text color={theme.success}>y</Text> allow · <Text color={theme.success}>a</Text> always ·{" "}
        <Text color={theme.error}>n</Text> deny
      </Text>
    </Box>
  );
}
