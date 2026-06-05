import React from "react";
import { Box, Text } from "ink";
import type { Entry } from "./types.ts";
import { ToolCallView } from "./ToolCallView.tsx";
import { theme } from "./theme.ts";
import { BULLET, WELCOME } from "./figures.ts";

export function EntryView({ entry, verbose }: { entry: Entry; verbose?: boolean }) {
  switch (entry.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={theme.dim}>{"> "}</Text>
          <Text color={theme.dim}>{entry.text}</Text>
        </Box>
      );
    case "assistant":
      // ⏺ bullet in its own column so wrapped lines align under the text.
      return (
        <Box marginTop={1}>
          <Text color={theme.accent}>{BULLET} </Text>
          <Box flexGrow={1}>
            <Text>{entry.text}</Text>
          </Box>
        </Box>
      );
    case "thinking":
      // The model's reasoning, rendered dimmed under a thinking mark.
      return (
        <Box marginTop={1}>
          <Text color={theme.dim}>{WELCOME} </Text>
          <Box flexGrow={1}>
            <Text color={theme.dim} dimColor>
              {entry.text}
            </Text>
          </Box>
        </Box>
      );
    case "tool":
      return <ToolCallView entry={entry} verbose={verbose} />;
    case "notice":
      return (
        <Box marginTop={1} flexDirection="column">
          {entry.text.split("\n").map((l, i) => (
            <Text
              key={i}
              color={entry.tone === "error" ? theme.error : theme.dim}
              dimColor={entry.tone !== "error"}
            >
              {l}
            </Text>
          ))}
        </Box>
      );
  }
}

// Render a list of finalized entries (used inside Ink's <Static> for the committed
// transcript) — kept as a plain map so the same EntryView powers live rendering too.
export function Transcript({ entries }: { entries: Entry[] }) {
  return (
    <Box flexDirection="column">
      {entries.map((e, i) => (
        <EntryView key={i} entry={e} />
      ))}
    </Box>
  );
}
