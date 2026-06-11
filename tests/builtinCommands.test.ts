import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/commands/registry.ts";
import { Config } from "../src/config/schema.ts";
import { emptyUsage } from "../src/engine/events.ts";

function ctx(over: Partial<Parameters<typeof runCommand>[1]> = {}) {
  return {
    config: Config.parse({ contextBudget: 1000, compactRatio: 0.8 }),
    modelSpec: "anthropic:claude-opus-4-8",
    mode: "default" as const,
    usage: { ...emptyUsage(), inputTokens: 120, outputTokens: 80, totalTokens: 200 },
    context: { used: 200, budget: 1000 },
    cwd: process.cwd(),
    todos: [],
    ...over,
  };
}

test("/context reports token usage against the budget", () => {
  const res = runCommand("/context", ctx());
  assert.ok(res && res.type === "notice");
  assert.match((res as any).text, /200 tokens \(20% of 1000\)/);
  assert.match((res as any).text, /auto-compact at ~800 tokens/);
});

test("/memory shows PRIVATEER.md when present, guidance when not", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-mem-"));
  try {
    const miss = runCommand("/memory", ctx({ cwd: dir }));
    assert.match((miss as any).text, /No PRIVATEER\.md yet/);

    writeFileSync(join(dir, "PRIVATEER.md"), "# Project\n\n- uses tsx", "utf8");
    const hit = runCommand("/memory", ctx({ cwd: dir }));
    assert.match((hit as any).text, /uses tsx/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/export returns an export result with an optional path", () => {
  assert.deepEqual(runCommand("/export", ctx()), { type: "export", path: undefined });
  assert.deepEqual(runCommand("/export out.md", ctx()), { type: "export", path: "out.md" });
});
