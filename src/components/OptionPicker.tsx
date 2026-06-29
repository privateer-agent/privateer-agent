import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { UserQuestion, UserAnswer } from "../tools/askUser.ts";
import { theme } from "./theme.ts";

// Interactive picker shown when the agent calls `ask_user` to choose between
// competing approaches. The turn is blocked on the human (like the approval prompt).
// Keys: ↑/↓ move, 1–N jump, Enter confirm, e (or the last row) write a custom answer,
// Esc dismiss. In multiSelect mode, Space/number toggles and Enter confirms the set.
export function OptionPicker({
  question,
  onRespond,
}: {
  question: UserQuestion;
  onRespond: (answer: UserAnswer) => void;
}) {
  const { options, multiSelect } = question;
  const otherIndex = options.length; // the trailing "write your own" row
  const total = options.length + 1;
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<"list" | "custom">("list");
  const [draft, setDraft] = useState("");

  function toggle(i: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function confirm() {
    if (cursor === otherIndex) {
      setMode("custom");
      return;
    }
    if (multiSelect) {
      const picks = checked.size > 0 ? [...checked] : [cursor];
      onRespond({ kind: "selected", indices: picks.sort((a, b) => a - b) });
    } else {
      onRespond({ kind: "selected", indices: [cursor] });
    }
  }

  useInput((input, key) => {
    if (mode === "custom") {
      if (key.escape) {
        setMode("list");
        setDraft("");
      } else if (key.return) {
        const text = draft.trim();
        if (text) onRespond({ kind: "custom", text });
      } else if (key.backspace || key.delete) {
        setDraft((d) => d.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setDraft((d) => d + input);
      }
      return;
    }

    if (key.upArrow) setCursor((c) => (c - 1 + total) % total);
    else if (key.downArrow) setCursor((c) => (c + 1) % total);
    else if (key.escape) onRespond({ kind: "dismissed" });
    else if (input === "e") setMode("custom");
    else if (input >= "1" && input <= "9") {
      const i = Number(input) - 1;
      if (i < options.length) {
        if (multiSelect) {
          setCursor(i);
          toggle(i);
        } else {
          onRespond({ kind: "selected", indices: [i] });
        }
      }
    } else if (input === " " && multiSelect && cursor < options.length) {
      toggle(cursor);
    } else if (key.return) {
      confirm();
    }
  });

  if (mode === "custom") {
    return (
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold color={theme.accent}>
          {question.question}
        </Text>
        <Text>
          <Text color={theme.dim}>your answer: </Text>
          {draft}
          <Text color={theme.accent}>▏</Text>
        </Text>
        <Text dimColor>enter submit · esc back to options</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold color={theme.accent}>
        {question.question}
      </Text>
      {options.map((o, i) => {
        const active = i === cursor;
        const box = multiSelect ? (checked.has(i) ? "[x] " : "[ ] ") : "";
        return (
          <Box key={i} flexDirection="column" marginTop={1}>
            <Text color={active ? theme.accent : undefined}>
              <Text color={active ? theme.accent : theme.dim}>{active ? "❯ " : "  "}</Text>
              <Text color={theme.dim}>{i + 1}. </Text>
              {box}
              <Text bold={active}>{o.label}</Text>
            </Text>
            {o.description ? <Text dimColor>{"     " + o.description}</Text> : null}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={cursor === otherIndex ? theme.accent : undefined}>
          <Text color={cursor === otherIndex ? theme.accent : theme.dim}>{cursor === otherIndex ? "❯ " : "  "}</Text>
          <Text color={theme.dim}>e. </Text>
          <Text bold={cursor === otherIndex}>Something else — write your own answer</Text>
        </Text>
      </Box>
      <Text dimColor>
        {multiSelect
          ? "↑/↓ move · space toggle · enter confirm · esc skip"
          : "↑/↓ move · 1–" + options.length + " pick · enter confirm · esc skip"}
      </Text>
    </Box>
  );
}
