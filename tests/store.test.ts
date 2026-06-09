import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSession, loadLatest, newSessionId } from "../src/memory/store.ts";
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
