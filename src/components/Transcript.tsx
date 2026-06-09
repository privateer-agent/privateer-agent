import React from "react";
import { Box, Text } from "ink";
import type { Entry } from "./types.ts";
import { ToolCallView } from "./ToolCallView.tsx";
import { theme } from "./theme.ts";
import { BULLET, WELCOME } from "./figures.ts";

// Pull a trailing `recap: …` line off an assistant message so it can be styled
// separately. Only the last line is considered, and only if it starts with the
// marker; otherwise the whole text is the body and there's no recap.
function splitRecap(text: string): { body: string; recap?: string } {
  const trimmed = text.replace(/\s+$/, "");
  const nl = trimmed.lastIndexOf("\n");
  const lastLine = trimmed.slice(nl + 1);
  if (/^recap:\s*/i.test(lastLine)) {
    return { body: trimmed.slice(0, nl < 0 ? 0 : nl).replace(/\s+$/, ""), recap: lastLine };
  }
  return { body: text };
}

export function EntryView({
  entry,
  verbose,
  collapsed,
}: {
  entry: Entry;
  verbose?: boolean;
  collapsed?: boolean;
}) {
  switch (entry.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color={theme.dim}>{"> "}</Text>
          <Text color={theme.dim}>{entry.text}</Text>
        </Box>
      );
    case "assistant": {
      // Split off a trailing `recap:` line so it can render dimmed below the
      // response body. The model is asked to end each turn with one such line.
      const { body, recap } = splitRecap(entry.text);
      // ⏺ bullet in its own column so wrapped lines align under the text.
      return (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={theme.accent}>{BULLET} </Text>
            <Box flexGrow={1}>
              <Text>{body}</Text>
            </Box>
          </Box>
          {recap && (
            <Box marginTop={1}>
              <Text color={theme.dim}>{"  "}</Text>
              <Box flexGrow={1}>
                <Text color={theme.dim} dimColor>
                  {recap}
                </Text>
              </Box>
            </Box>
          )}
        </Box>
      );
    }
    case "thinking": {
      // The model's reasoning, rendered dimmed under a thinking mark. When
      // collapsed (Ctrl+O), show just a one-line summary instead of the full text.
      if (collapsed) {
        const lineCount = entry.text.trim() === "" ? 0 : entry.text.trim().split("\n").length;
        return (
          <Box marginTop={1}>
            <Text color={theme.dim} dimColor>
              {WELCOME} Thinking{lineCount ? ` (${lineCount} lines)` : ""} — Ctrl+O to expand
            </Text>
          </Box>
        );
      }
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
    }
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
          {entry.hint &&
            entry.hint.split("\n").map((l, i) => (
              <Text key={`hint-${i}`} color={theme.dim} dimColor>
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
