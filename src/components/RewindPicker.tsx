import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.ts";
import { POINTER } from "./figures.ts";
import type { Checkpoint, RewindScope } from "../memory/checkpoints.ts";

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// Lists checkpoints (newest first). Move with ↑/↓ (or j/k); restore with a scope
// key — b/Enter both, c conversation, f files; Esc cancels.
export function RewindPicker({
  checkpoints,
  onRestore,
  onCancel,
}: {
  checkpoints: Checkpoint[];
  onRestore: (id: string, scope: RewindScope) => void;
  onCancel: () => void;
}) {
  const items = [...checkpoints].reverse(); // newest first
  const [sel, setSel] = useState(0);

  useInput((input, key) => {
    if (key.escape) return void onCancel();
    if (items.length === 0) return;
    if (key.upArrow || input === "k") return void setSel((s) => (s - 1 + items.length) % items.length);
    if (key.downArrow || input === "j") return void setSel((s) => (s + 1) % items.length);
    const cp = items[Math.min(sel, items.length - 1)];
    if (key.return || input === "b") return void onRestore(cp.id, "both");
    if (input === "c") return void onRestore(cp.id, "conversation");
    if (input === "f") return void onRestore(cp.id, "files");
  });

  if (items.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.dim}>No checkpoints yet — they're taken before each turn. Esc to close.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent}>Rewind to a checkpoint</Text>
      {items.map((cp, i) => {
        const active = i === Math.min(sel, items.length - 1);
        const nFiles = Object.keys(cp.files).length;
        return (
          <Box key={cp.id} gap={1}>
            <Text color={active ? theme.accent : theme.dim}>{active ? POINTER : " "}</Text>
            <Text color={active ? theme.accent : undefined}>{cp.label}</Text>
            <Text color={theme.dim}>
              ({ago(cp.ts)}{nFiles ? `, ${nFiles} file${nFiles === 1 ? "" : "s"}` : ""})
            </Text>
          </Box>
        );
      })}
      <Text color={theme.dim}>
        <Text color={theme.accent}>b</Text>/enter both · <Text color={theme.accent}>c</Text> conversation ·{" "}
        <Text color={theme.accent}>f</Text> files · esc cancel
      </Text>
    </Box>
  );
}
