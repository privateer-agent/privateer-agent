import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.ts";
import { POINTER } from "./figures.ts";
import type { SessionMeta } from "../memory/store.ts";

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Lists past sessions (newest first). Move with ↑/↓ (or j/k); Enter resumes the
// selected session, Esc cancels.
export function SessionPicker({
  sessions,
  onResume,
  onCancel,
}: {
  sessions: SessionMeta[];
  onResume: (id: string) => void;
  onCancel: () => void;
}) {
  const [sel, setSel] = useState(0);

  useInput((input, key) => {
    if (key.escape) return void onCancel();
    if (sessions.length === 0) return;
    if (key.upArrow || input === "k") return void setSel((s) => (s - 1 + sessions.length) % sessions.length);
    if (key.downArrow || input === "j") return void setSel((s) => (s + 1) % sessions.length);
    if (key.return) return void onResume(sessions[Math.min(sel, sessions.length - 1)].id);
  });

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.dim}>No saved sessions yet for this project. Esc to close.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent}>Resume a session</Text>
      {sessions.map((s, i) => {
        const active = i === Math.min(sel, sessions.length - 1);
        return (
          <Box key={s.id} gap={1}>
            <Text color={active ? theme.accent : theme.dim}>{active ? POINTER : " "}</Text>
            <Text color={active ? theme.accent : undefined}>{s.preview}</Text>
            <Text color={theme.dim}>
              ({ago(s.updatedAt)}, {s.messageCount} msg{s.messageCount === 1 ? "" : "s"})
            </Text>
          </Box>
        );
      })}
      <Text color={theme.dim}>
        <Text color={theme.accent}>↑↓</Text> move · <Text color={theme.accent}>enter</Text> resume · esc cancel
      </Text>
    </Box>
  );
}
