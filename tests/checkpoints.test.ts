import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
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

test("persisted checkpoints survive a reload (restart-and-resume)", () => {
  const work = mkdtempSync(join(tmpdir(), "priv-ckpt-work-"));
  const ckpt = mkdtempSync(join(tmpdir(), "priv-ckpt-store-"));
  try {
    const f = join(work, "f.txt");
    const g = join(work, "g.txt");
    writeFileSync(f, "v0", "utf8");

    // First "process": take a checkpoint, then edit f and create g.
    const store = CheckpointStore.load(ckpt);
    const cp = store.create({ messagesLength: 2, committedLength: 3, label: "before edits" });
    mutate(store, f, "v1");
    mutate(store, g, "created");

    // Second "process": rehydrate purely from disk and rewind to the saved checkpoint.
    const reloaded = CheckpointStore.load(ckpt);
    const list = reloaded.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, cp.id);
    assert.equal(list[0].label, "before edits");

    reloaded.restoreFiles(reloaded.get(cp.id)!);
    assert.equal(readFileSync(f, "utf8"), "v0"); // f restored from a persisted blob
    assert.equal(existsSync(g), false); // g (created after the checkpoint) removed
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(ckpt, { recursive: true, force: true });
  }
});

test("retention cap drops old checkpoints and garbage-collects orphaned blobs", () => {
  const work = mkdtempSync(join(tmpdir(), "priv-ckpt-gc-work-"));
  const ckpt = mkdtempSync(join(tmpdir(), "priv-ckpt-gc-store-"));
  const blobs = join(ckpt, "blobs");
  try {
    const f = join(work, "f.txt");
    writeFileSync(f, "v0", "utf8");

    // Cap of 2: each turn edits f to a unique value, then checkpoints.
    const store = new CheckpointStore(ckpt, 2);
    for (let i = 1; i <= 5; i++) {
      mutate(store, f, `v${i}`);
      store.create({ messagesLength: i, committedLength: i, label: `turn ${i}` });
    }

    // Only the last 2 checkpoints survive.
    assert.equal(store.list().length, 2);

    // Live blobs: the baseline v0 (original) plus the contents the surviving two
    // checkpoints reference — far fewer than the 6 unique versions ever written.
    const remaining = readdirSync(blobs);
    assert.ok(remaining.length <= 4, `expected GC to bound blobs, saw ${remaining.length}`);

    // The older of the two survivors is turn 4 (which captured f as "v4"); it still
    // restores correctly from a retained blob.
    const oldest = store.list()[0];
    assert.equal(oldest.label, "turn 4");
    store.restoreFiles(oldest);
    assert.equal(readFileSync(f, "utf8"), "v4");
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(ckpt, { recursive: true, force: true });
  }
});

test("branchTo copies history to a new dir, truncates past the branch point, and leaves the source intact", () => {
  const work = mkdtempSync(join(tmpdir(), "priv-ckpt-branch-work-"));
  const src = mkdtempSync(join(tmpdir(), "priv-ckpt-branch-src-"));
  const dst = join(mkdtempSync(join(tmpdir(), "priv-ckpt-branch-dst-")), "branch");
  try {
    const f = join(work, "f.txt");
    writeFileSync(f, "v0", "utf8");

    const store = CheckpointStore.load(src);
    const cp1 = store.create({ messagesLength: 0, committedLength: 0, label: "turn 1" });
    mutate(store, f, "v1");
    const cp2 = store.create({ messagesLength: 2, committedLength: 2, label: "turn 2" });
    mutate(store, f, "v2");
    store.create({ messagesLength: 4, committedLength: 4, label: "turn 3" });

    // Branch at cp2: the store re-points at dst, keeping cp1..cp2 only.
    store.branchTo(dst, cp2.id);
    assert.deepEqual(store.list().map((c) => c.id), [cp1.id, cp2.id]);

    // The branch persisted to disk: a fresh load from dst sees the truncated history
    // and can restore files from copied blobs.
    const branch = CheckpointStore.load(dst);
    assert.deepEqual(branch.list().map((c) => c.label), ["turn 1", "turn 2"]);
    branch.restoreFiles(branch.get(cp2.id)!);
    assert.equal(readFileSync(f, "utf8"), "v1");
    branch.restoreFiles(branch.get(cp1.id)!);
    assert.equal(readFileSync(f, "utf8"), "v0");

    // The source dir still has all three checkpoints — the session branched from
    // keeps its own future.
    const original = CheckpointStore.load(src);
    assert.deepEqual(original.list().map((c) => c.label), ["turn 1", "turn 2", "turn 3"]);

    // New mutations recorded after the branch persist to the branch dir, not src.
    mutate(store, f, "v-branch");
    store.create({ messagesLength: 2, committedLength: 2, label: "branch turn" });
    assert.equal(CheckpointStore.load(dst).list().length, 3);
    assert.equal(CheckpointStore.load(src).list().length, 3);
    assert.equal(CheckpointStore.load(src).list()[2].label, "turn 3");
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  }
});

test("branchTo without a checkpoint id (/fork) carries the full history", () => {
  const work = mkdtempSync(join(tmpdir(), "priv-ckpt-fork-work-"));
  const src = mkdtempSync(join(tmpdir(), "priv-ckpt-fork-src-"));
  const dst = join(mkdtempSync(join(tmpdir(), "priv-ckpt-fork-dst-")), "branch");
  try {
    const f = join(work, "f.txt");
    writeFileSync(f, "v0", "utf8");

    const store = CheckpointStore.load(src);
    const cp = store.create({ messagesLength: 0, committedLength: 0, label: "only turn" });
    mutate(store, f, "v1");

    store.branchTo(dst);
    const branch = CheckpointStore.load(dst);
    assert.deepEqual(branch.list().map((c) => c.id), [cp.id]);
    branch.restoreFiles(branch.get(cp.id)!);
    assert.equal(readFileSync(f, "utf8"), "v0"); // original baseline blob was copied
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
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
