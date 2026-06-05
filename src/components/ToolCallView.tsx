import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { ToolEntry } from "./types.ts";
import { theme, toolDisplayName } from "./theme.ts";
import { BULLET, TREE } from "./figures.ts";

// A one-line summary of a tool's input, picking the most relevant field per tool.
function summarizeInput(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return String(o.path ?? "");
    case "bash":
      return String(o.command ?? "");
    case "glob":
      return String(o.pattern ?? "");
    case "grep":
      return String(o.pattern ?? "") + (o.glob ? ` (${o.glob})` : "");
    default:
      try {
        return JSON.stringify(o);
      } catch {
        return "";
      }
  }
}

// Show the first few lines of tool output so the transcript stays compact.
function previewOutput(text: string, maxLines = 6): { lines: string[]; more: number } {
  const all = text.replace(/\n+$/, "").split("\n");
  return { lines: all.slice(0, maxLines), more: Math.max(0, all.length - maxLines) };
}

// Red/green line diff rendered from an edit tool's input (no engine data needed).
function EditDiff({ input }: { input: unknown }) {
  const o = (input ?? {}) as Record<string, unknown>;
  const removed = String(o.old_string ?? "").split("\n");
  const added = String(o.new_string ?? "").split("\n");
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color={theme.dim}>{TREE} </Text>
      {removed.map((l, i) => (
        <Text key={`r${i}`} color={theme.diffRemoved}>
          {"  - "}
          {l}
        </Text>
      ))}
      {added.map((l, i) => (
        <Text key={`a${i}`} color={theme.diffAdded}>
          {"  + "}
          {l}
        </Text>
      ))}
    </Box>
  );
}

export function ToolCallView({ entry, verbose }: { entry: ToolEntry; verbose?: boolean }) {
  const summary = summarizeInput(entry.name, entry.input);
  const body = entry.status === "error" ? entry.error ?? "" : entry.output ?? "";
  const { lines, more } = previewOutput(body, verbose ? Number.MAX_SAFE_INTEGER : 6);
  const isEditDiff = entry.name === "edit" && entry.status !== "error";

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box gap={1}>
        {entry.status === "running" ? (
          <Text color={theme.accent}>
            <Spinner type="dots" />
          </Text>
        ) : (
          <Text color={entry.status === "error" ? theme.error : theme.accent}>{BULLET}</Text>
        )}
        <Text>
          <Text bold color={theme.accent}>
            {toolDisplayName(entry.name)}
          </Text>
          <Text color={theme.dim}>({summary})</Text>
        </Text>
      </Box>

      {entry.status !== "running" &&
        (isEditDiff ? (
          <EditDiff input={entry.input} />
        ) : (
          body.trim() !== "" && (
            <Box flexDirection="column" marginLeft={2}>
              {lines.map((l, i) => (
                <Text
                  key={i}
                  color={entry.status === "error" ? theme.error : theme.dim}
                  dimColor={entry.status !== "error"}
                >
                  {i === 0 ? `${TREE}  ` : "   "}
                  {l}
                </Text>
              ))}
              {more > 0 && <Text color={theme.dim}>{"   "}… (+{more} more lines)</Text>}
            </Box>
          )
        ))}
    </Box>
  );
}
