import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgents, findAgent } from "../src/agents/loader.ts";
import { createToolSubset } from "../src/tools/index.ts";
import { autoApproveGate } from "../src/permissions/gate.ts";

test("loadAgents parses frontmatter; project overrides user", () => {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const proj = mkdtempSync(join(tmpdir(), "priv-proj-"));
  const prevHome = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    mkdirSync(join(home, "agents"), { recursive: true });
    mkdirSync(join(proj, ".privateer", "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "reviewer.md"), "user reviewer instructions", "utf8");
    writeFileSync(
      join(proj, ".privateer", "agents", "reviewer.md"),
      "---\ndescription: Reviews diffs\ntools: read, grep\nmodel: anthropic:claude-haiku-4-5\n---\nReview the changes for bugs.",
      "utf8",
    );

    const agents = loadAgents(proj);
    const reviewer = findAgent("reviewer", proj);
    assert.ok(reviewer);
    assert.equal(reviewer!.scope, "project"); // project wins
    assert.equal(reviewer!.description, "Reviews diffs");
    assert.deepEqual(reviewer!.tools, ["read", "grep"]);
    assert.equal(reviewer!.model, "anthropic:claude-haiku-4-5");
    assert.match(reviewer!.prompt, /Review the changes/);
    assert.equal(agents.length, 1);
  } finally {
    if (prevHome === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("createToolSubset grants only named tools, never task/todo", () => {
  const ctx = { cwd: process.cwd(), gate: autoApproveGate };
  const subset = createToolSubset(ctx, ["read", "bash", "todo", "task", "nope"]);
  assert.deepEqual(Object.keys(subset).sort(), ["bash", "read"]); // todo/task/unknown dropped
});

test("createToolSubset falls back to read-only when empty", () => {
  const ctx = { cwd: process.cwd(), gate: autoApproveGate };
  assert.deepEqual(Object.keys(createToolSubset(ctx)).sort(), ["glob", "grep", "read"]);
  assert.deepEqual(Object.keys(createToolSubset(ctx, [])).sort(), ["glob", "grep", "read"]);
});
