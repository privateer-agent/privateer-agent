import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "../src/memory/checkpoints.ts";

// Simulate the write/edit tools: record the mutation, then apply it.
function mutate(store: CheckpointStore, path: string, content: string) {
  store.recordMutation(path);
  writeFileSync(path, content, "utf8");
}

test("rewind restores file content and removes session-created files", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-ckpt-"));
  try {
    const f = join(dir, "f.txt");
    const g = join(dir, "g.txt");
    writeFileSync(f, "v0", "utf8"); // pre-existing file

    const store = new CheckpointStore();

    // Checkpoint before turn 1 (nothing touched yet).
    const cp1 = store.create({ messagesLength: 0, committedLength: 0, label: "first turn" });
    // Turn 1 edits f.
    mutate(store, f, "v1");

    // Checkpoint before turn 2 (f touched).
    const cp2 = store.create({ messagesLength: 2, committedLength: 3, label: "second turn" });
    // Turn 2 edits f again and creates a brand-new file g.
    mutate(store, f, "v2");
    mutate(store, g, "g-created");

    // Sanity: current state.
    assert.equal(readFileSync(f, "utf8"), "v2");
    assert.ok(existsSync(g));

    // Rewind to cp2: f back to its pre-turn-2 content; g (created after cp2) removed.
    store.restoreFiles(cp2);
    assert.equal(readFileSync(f, "utf8"), "v1");
    assert.equal(existsSync(g), false);

    // Re-create g, then rewind all the way to cp1: f back to original; g removed.
    mutate(store, g, "g-again");
    store.restoreFiles(cp1);
    assert.equal(readFileSync(f, "utf8"), "v0");
    assert.equal(existsSync(g), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpoints record conversation lengths and a labelled list", () => {
  const store = new CheckpointStore();
  store.create({ messagesLength: 0, committedLength: 0, label: "  add   login   " });
  store.create({ messagesLength: 4, committedLength: 5, label: "fix bug" });

  const list = store.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].label, "add login"); // whitespace collapsed
  assert.equal(list[1].messagesLength, 4);
  assert.equal(list[1].committedLength, 5);
  assert.ok(store.get(list[1].id));
  assert.equal(store.get("missing"), undefined);
});
