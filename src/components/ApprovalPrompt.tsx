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

  // Quiet cue for elevated-stakes requests — stays in the blue theme, just flags
  // that this one is weightier than a routine approval. Order = most severe first.
  const badge = req.alwaysAsk
    ? "destructive"
    : req.protected
      ? "guarded file"
      : req.outside
        ? "outside cwd"
        : undefined;

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text>
        <Text bold color={theme.accent}>
          {req.title}
        </Text>
        <Text dimColor> ({req.tool})</Text>
        {badge && <Text dimColor>  ⚠ {badge}</Text>}
      </Text>
      <Text>{req.detail}</Text>
      <Text dimColor>
        <Text color={theme.accent}>y</Text> allow · <Text color={theme.accent}>a</Text> always ·{" "}
        <Text color={theme.accentDim}>n</Text> deny
      </Text>
    </Box>
  );
}
