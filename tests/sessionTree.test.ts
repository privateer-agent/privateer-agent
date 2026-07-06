import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionTreeRows } from "../src/components/SessionPicker.tsx";
import type { SessionMeta } from "../src/memory/store.ts";

function meta(id: string, parentId?: string, forkLabel?: string): SessionMeta {
  return {
    id,
    updatedAt: "2026-07-06T00:00:00.000Z",
    modelSpec: "anthropic:claude-opus-4-8",
    messageCount: 2,
    preview: `session ${id}`,
    parentId,
    forkLabel,
  };
}

test("sessionTreeRows indents branches under their parent, keeping sibling order", () => {
  // Newest-first input, as listSessions returns: two branches of s-1, one nested.
  const rows = sessionTreeRows([
    meta("s-4", "s-2", "fix bug"), // branch of a branch
    meta("s-3", "s-1"),
    meta("s-2", "s-1", "add login"),
    meta("s-1"),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.meta.id, r.depth]),
    [
      ["s-1", 0],
      ["s-3", 1],
      ["s-2", 1],
      ["s-4", 2],
    ],
  );
});

test("sessionTreeRows falls back to flat rows when lineage is absent or broken", () => {
  // No parents at all → flat, original order.
  const flat = sessionTreeRows([meta("s-2"), meta("s-1")]);
  assert.deepEqual(flat.map((r) => [r.meta.id, r.depth]), [["s-2", 0], ["s-1", 0]]);

  // Parent missing from the list (deleted, or it's the live session the caller
  // excluded) → the orphan renders as a root.
  const orphan = sessionTreeRows([meta("s-2", "s-gone"), meta("s-1")]);
  assert.deepEqual(orphan.map((r) => [r.meta.id, r.depth]), [["s-2", 0], ["s-1", 0]]);

  // A corrupt parent cycle still renders every session exactly once.
  const cycle = sessionTreeRows([meta("s-2", "s-1"), meta("s-1", "s-2"), meta("s-0")]);
  assert.equal(cycle.length, 3);
  assert.deepEqual(new Set(cycle.map((r) => r.meta.id)), new Set(["s-0", "s-1", "s-2"]));
});
