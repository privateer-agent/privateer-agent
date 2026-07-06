import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { SessionPicker, sessionTreeRows } from "../src/components/SessionPicker.tsx";
import type { SessionMeta } from "../src/memory/store.ts";

function meta(id: string, parentId?: string, forkLabel?: string, name?: string): SessionMeta {
  return {
    id,
    updatedAt: "2026-07-06T00:00:00.000Z",
    modelSpec: "anthropic:claude-opus-4-8",
    messageCount: 2,
    preview: `session ${id}`,
    parentId,
    forkLabel,
    name,
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

// Ink attaches its stdin listener asynchronously and re-renders on its own
// schedule, so fixed sleeps flake under load. Poll the frame (or an arbitrary
// condition) until it holds, retrying the triggering keystroke each round in
// case an early write raced the listener attach.
async function until(check: () => boolean, retry?: () => void): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    retry?.();
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(check(), "condition not reached within the deadline");
}

test("SessionPicker shows branch names and deletes only after d → y on the same row", async () => {
  const deleted: string[] = [];
  const { lastFrame, stdin, unmount } = render(
    React.createElement(SessionPicker, {
      sessions: [meta("s-2", "s-1", "add login", "auth-experiment"), meta("s-1")],
      onResume: () => {},
      onDelete: (id: string) => deleted.push(id),
      onCancel: () => {},
    }),
  );
  try {
    await until(() => /\[auth-experiment\]/.test(lastFrame() ?? "")); // name on the branch row
    assert.match(lastFrame() ?? "", /d.*delete/); // footer advertises deletion

    // `d` arms the confirm on the selected row; any non-y key backs out.
    await until(
      () => /delete\? y\/n/.test(lastFrame() ?? ""),
      () => stdin.write("d"),
    );
    stdin.write("n");
    await until(() => !/delete\? y\/n/.test(lastFrame() ?? ""));
    assert.deepEqual(deleted, []);

    // d → y deletes the selected session (the first row, s-1: it's the tree root).
    await until(
      () => /delete\? y\/n/.test(lastFrame() ?? ""),
      () => stdin.write("d"),
    );
    stdin.write("y");
    await until(() => deleted.length > 0);
    assert.deepEqual(deleted, ["s-1"]);
  } finally {
    unmount();
  }
});
