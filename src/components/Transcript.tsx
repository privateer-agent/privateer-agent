import React from "react";
import { Box, Text } from "ink";
import type { Entry, Row, ToolEntry } from "./types.ts";
import { ToolCallView } from "./ToolCallView.tsx";
import { AgentGroupView } from "./AgentGroupView.tsx";
import { theme } from "./theme.ts";
import { Markdown } from "./Markdown.tsx";
import { BULLET, WELCOME } from "./figures.ts";

// Visual height of `text` once wrapped to `cols` columns — `\n`-lines plus the
// extra rows each long line wraps onto.
export function visualRows(text: string, cols: number): number {
  let rows = 0;
  for (const ln of text.split("\n")) rows += Math.max(1, Math.ceil(ln.length / Math.max(1, cols)));
  return rows;
}

// Trim a still-streaming block to roughly its last `maxRows` wrapped rows so the live
// region stays within the terminal. The hidden prefix isn't lost: the full text is
// what gets committed to <Static> when the turn ends, so it lands intact in
// scrollback. Returns the text unchanged when it already fits.
export function clampStreamingText(text: string, maxRows: number, cols: number): string {
  const lines = text.split("\n");
  const width = Math.max(1, cols);
  let rows = 0;
  let i = lines.length;
  while (i > 0) {
    const r = Math.max(1, Math.ceil(lines[i - 1].length / width));
    if (rows + r > maxRows - 1) break; // reserve one row for the "…hidden" marker
    rows += r;
    i--;
  }
  if (i === 0) return text;
  return `⋮ ${i} earlier line${i === 1 ? "" : "s"} hidden — shown in full when complete\n${lines.slice(i).join("\n")}`;
}

// Collapse runs of two-or-more consecutive `task` tool entries (sub-agents the model
// fanned out in one turn) into a single grouped row, leaving everything else as-is. A
// lone task stays a normal tool call. Grouping is purely a render concern, so it runs
// over the entry list at paint time rather than mutating the transcript.
export function groupRows(entries: Entry[]): Row[] {
  const rows: Row[] = [];
  let run: ToolEntry[] = [];
  const flush = () => {
    if (run.length >= 2) rows.push({ kind: "agent-group", agents: run });
    else rows.push(...run);
    run = [];
  };
  for (const e of entries) {
    if (e.kind === "tool" && e.name === "task") run.push(e);
    else {
      flush();
      rows.push(e);
    }
  }
  flush();
  return rows;
}

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
              <Markdown text={body} />
            </Box>
          </Box>
          {recap && (
            <Box marginTop={1}>
              <Text color={theme.dim}>{"  "}</Text>
              <Box flexGrow={1}>
                <Text color="white">
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

// Render one grouped row: a fanned-out agent block, or any other single entry.
export function RowView({
  row,
  verbose,
  collapsed,
}: {
  row: Row;
  verbose?: boolean;
  collapsed?: boolean;
}) {
  return row.kind === "agent-group" ? (
    <AgentGroupView agents={row.agents} collapsed={collapsed} />
  ) : (
    <EntryView entry={row} verbose={verbose} collapsed={collapsed} />
  );
}

// Render a list of finalized entries (used inside Ink's <Static> for the committed
// transcript) — kept as a plain map so the same RowView powers live rendering too.
export function Transcript({ entries }: { entries: Entry[] }) {
  return (
    <Box flexDirection="column">
      {groupRows(entries).map((row, i) => (
        <RowView key={i} row={row} />
      ))}
    </Box>
  );
}
