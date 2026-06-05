import React from "react";
import { Box, Text } from "ink";
import type { TodoItem } from "../tools/todoStore.ts";
import { theme } from "./theme.ts";

const MARK: Record<TodoItem["status"], string> = {
  completed: "✔",
  in_progress: "▸",
  pending: "○",
};

// The live task panel, rendered above the status bar: completed items
// dimmed/struck, the in-progress item highlighted. Hidden when there are no todos.
export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === "completed").length;

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.dim} paddingX={1}>
      <Text dimColor>
        Tasks {done}/{todos.length}
      </Text>
      {todos.map((t, i) => {
        const label = t.status === "in_progress" ? t.activeForm ?? t.content : t.content;
        const color =
          t.status === "in_progress" ? theme.accent : t.status === "completed" ? theme.success : undefined;
        return (
          <Text key={i} color={color} dimColor={t.status === "pending"}>
            {MARK[t.status]}{" "}
            <Text strikethrough={t.status === "completed"}>{label}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
