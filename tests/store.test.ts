import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSession, loadLatest, loadSession, listSessions, newSessionId } from "../src/memory/store.ts";
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
