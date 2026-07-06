import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveSession,
  loadLatest,
  loadSession,
  listSessions,
  deleteSession,
  newSessionId,
  checkpointsDir,
} from "../src/memory/store.ts";
import { emptyUsage } from "../src/engine/events.ts";

test("session save/load round-trips per project, isolated via PRIVATEER_HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "privateer-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    const cwdA = "/work/projectA";
    const cwdB = "/work/projectB";

    assert.equal(loadLatest(cwdA), null);

    const id = newSessionId();
    saveSession(cwdA, id, {
      modelSpec: "anthropic:claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }] as any,
      usage: { ...emptyUsage(), totalTokens: 42 },
    });

    const loaded = loadLatest(cwdA);
    assert.ok(loaded);
    assert.equal(loaded!.id, id);
    assert.equal(loaded!.modelSpec, "anthropic:claude-opus-4-8");
    assert.equal(loaded!.usage.totalTokens, 42);
    assert.equal(loaded!.messages.length, 1);
    assert.ok(loaded!.updatedAt);

    // Different project key → independent (no cross-talk).
    assert.equal(loadLatest(cwdB), null);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("branched sessions persist lineage and pin latest.json to the branch", () => {
  const home = mkdtempSync(join(tmpdir(), "privateer-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    const cwd = "/work/projectC";
    const usage = emptyUsage();

    // Original session with two turns.
    const rootId = "s-1000";
    saveSession(cwd, rootId, {
      modelSpec: "anthropic:claude-opus-4-8",
      messages: [
        { role: "user", content: "turn one" },
        { role: "assistant", content: "reply one" },
        { role: "user", content: "turn two" },
        { role: "assistant", content: "reply two" },
      ] as any,
      usage,
    });

    // Branch rewound to after turn one, carrying a parent pointer.
    const branchId = "s-2000";
    saveSession(cwd, branchId, {
      modelSpec: "anthropic:claude-opus-4-8",
      messages: [
        { role: "user", content: "turn one" },
        { role: "assistant", content: "reply one" },
      ] as any,
      usage,
      parent: { id: rootId, checkpointId: "cp2", label: "turn two" },
    });

    // Parent pointer round-trips through the session file.
    const branch = loadSession(cwd, branchId);
    assert.ok(branch);
    assert.deepEqual(branch!.parent, { id: rootId, checkpointId: "cp2", label: "turn two" });

    // The original keeps its full future, untouched by the branch save.
    const root = loadSession(cwd, rootId);
    assert.equal(root!.messages.length, 4);
    assert.equal(root!.parent, undefined);

    // Pin: latest.json follows the branch, so --continue resumes the branch.
    assert.equal(loadLatest(cwd)!.id, branchId);

    // The picker metadata carries lineage for the tree view.
    const metas = listSessions(cwd);
    const branchMeta = metas.find((m) => m.id === branchId)!;
    assert.equal(branchMeta.parentId, rootId);
    assert.equal(branchMeta.forkLabel, "turn two");
    assert.equal(metas.find((m) => m.id === rootId)!.parentId, undefined);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("session name round-trips through the file and the picker metadata", () => {
  const home = mkdtempSync(join(tmpdir(), "privateer-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    const cwd = "/work/projectD";
    saveSession(cwd, "s-3000", {
      modelSpec: "anthropic:claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }] as any,
      usage: emptyUsage(),
      parent: { id: "s-2999" },
      name: "auth-experiment",
    });
    assert.equal(loadSession(cwd, "s-3000")!.name, "auth-experiment");
    assert.equal(listSessions(cwd)[0].name, "auth-experiment");
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("deleteSession removes the file, its checkpoints, and the latest pin when it points there", () => {
  const home = mkdtempSync(join(tmpdir(), "privateer-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    const cwd = "/work/projectE";
    const usage = emptyUsage();
    saveSession(cwd, "s-1", {
      modelSpec: "m",
      messages: [{ role: "user", content: "one" }] as any,
      usage,
    });
    saveSession(cwd, "s-2", {
      modelSpec: "m",
      messages: [{ role: "user", content: "two" }] as any,
      usage,
    });
    // Give the doomed session a checkpoint dir, like a real branched session has.
    const cpDir = checkpointsDir(cwd, "s-2");
    mkdirSync(cpDir, { recursive: true });
    writeFileSync(join(cpDir, "index.json"), "{}", "utf8");

    // latest.json mirrors s-2 (the newest save) — deleting s-2 must clear the pin
    // so --continue can't resurrect it from the mirror.
    assert.equal(loadLatest(cwd)!.id, "s-2");
    deleteSession(cwd, "s-2");
    assert.equal(loadSession(cwd, "s-2"), null);
    assert.equal(existsSync(cpDir), false);
    assert.equal(loadLatest(cwd), null);
    assert.deepEqual(listSessions(cwd).map((s) => s.id), ["s-1"]);

    // Deleting a session latest does NOT point at leaves the pin alone.
    saveSession(cwd, "s-3", {
      modelSpec: "m",
      messages: [{ role: "user", content: "three" }] as any,
      usage,
    });
    deleteSession(cwd, "s-1");
    assert.equal(loadLatest(cwd)!.id, "s-3");
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
