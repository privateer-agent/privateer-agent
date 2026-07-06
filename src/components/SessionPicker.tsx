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

// One selectable line in the picker: a session plus its indentation depth in the
// branch tree (0 for roots).
export interface SessionTreeRow {
  meta: SessionMeta;
  depth: number;
}

// Arrange sessions into lineage order: each branch is indented under the session it
// forked from, keeping the incoming (newest-first) order among siblings and roots.
// Sessions whose parent isn't in the list (deleted, or it's the live session the
// caller excluded) fall back to top-level rows, so the picker degrades to the old
// flat list when there's no lineage to show. A visited guard makes a corrupt
// parent-cycle render as extra roots rather than hanging the UI.
export function sessionTreeRows(sessions: SessionMeta[]): SessionTreeRow[] {
  const ids = new Set(sessions.map((s) => s.id));
  const children = new Map<string, SessionMeta[]>();
  const roots: SessionMeta[] = [];
  for (const s of sessions) {
    if (s.parentId && ids.has(s.parentId) && s.parentId !== s.id) {
      children.set(s.parentId, [...(children.get(s.parentId) ?? []), s]);
    } else {
      roots.push(s);
    }
  }
  const rows: SessionTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (s: SessionMeta, depth: number) => {
    if (visited.has(s.id)) return;
    visited.add(s.id);
    rows.push({ meta: s, depth });
    for (const c of children.get(s.id) ?? []) visit(c, depth + 1);
  };
  for (const r of roots) visit(r, 0);
  // Anything still unvisited sat inside a parent cycle; surface it flat.
  for (const s of sessions) visit(s, 0);
  return rows;
}

// Lists past sessions (newest first), branches indented under the session they
// forked from. Move with ↑/↓ (or j/k); Enter resumes the selected session, Esc
// cancels.
export function SessionPicker({
  sessions,
  onResume,
  onCancel,
}: {
  sessions: SessionMeta[];
  onResume: (id: string) => void;
  onCancel: () => void;
}) {
  const rows = sessionTreeRows(sessions);
  const [sel, setSel] = useState(0);

  useInput((input, key) => {
    if (key.escape) return void onCancel();
    if (rows.length === 0) return;
    if (key.upArrow || input === "k") return void setSel((s) => (s - 1 + rows.length) % rows.length);
    if (key.downArrow || input === "j") return void setSel((s) => (s + 1) % rows.length);
    if (key.return) return void onResume(rows[Math.min(sel, rows.length - 1)].meta.id);
  });

  if (rows.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.dim}>No saved sessions yet for this project. Esc to close.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent}>Resume a session</Text>
      {rows.map(({ meta: s, depth }, i) => {
        const active = i === Math.min(sel, rows.length - 1);
        const fork = depth > 0 ? `⑂ ${s.forkLabel ? `from "${s.forkLabel}" ` : ""}` : "";
        return (
          <Box key={s.id} gap={1}>
            <Text color={active ? theme.accent : theme.dim}>
              {"  ".repeat(depth)}
              {active ? POINTER : " "}
            </Text>
            {fork ? <Text color={theme.dim}>{fork.trim()}</Text> : null}
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
