import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import {
  saveMemory,
  readMemory,
  listMemories,
  deleteMemory,
  loadMemoryContext,
  sanitizeName,
} from "../src/memory/auto.ts";
import {
  saveSession,
  loadSession,
  loadLatest,
  listSessions,
  newSessionId,
  projectKey,
} from "../src/memory/store.ts";
import { emptyUsage } from "../src/engine/events.ts";

// Run `fn` with an isolated global dir (PRIVATEER_HOME) and a stable cwd, restoring both
// afterward. cwd is just a key here, so it need not exist on disk.
function withHome(fn: (cwd: string) => void): void {
  const g = mkdtempSync(join(tmpdir(), "priv-mem-"));
  const prevHome = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = g;
  try {
    fn("/tmp/some-project");
  } finally {
    if (prevHome === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prevHome;
    rmSync(g, { recursive: true, force: true });
  }
}

test("sanitizeName produces safe kebab stems", () => {
  assert.equal(sanitizeName("User Prefers Tabs!"), "user-prefers-tabs");
  assert.equal(sanitizeName("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeName("Already-Kebab_1"), "already-kebab_1");
});

test("saveMemory writes a file, round-trips, and builds the index", () => {
  withHome((cwd) => {
    const rec = saveMemory(cwd, {
      name: "user-prefers-tabs",
      description: "Prefers tabs over spaces",
      type: "feedback",
      body: "Use tabs in TS files.",
    });
    assert.equal(rec.scope, "project");
    assert.ok(existsSync(rec.path));

    const got = readMemory(cwd, "user-prefers-tabs");
    assert.ok(got);
    assert.equal(got!.description, "Prefers tabs over spaces");
    assert.equal(got!.type, "feedback");
    assert.equal(got!.body, "Use tabs in TS files.");

    const ctx = loadMemoryContext(cwd);
    assert.ok(ctx);
    assert.match(ctx!, /\(project\)/);
    assert.match(ctx!, /user-prefers-tabs/);
    assert.match(ctx!, /Prefers tabs over spaces/);
  });
});

test("project memories override global on name clash", () => {
  withHome((cwd) => {
    saveMemory(cwd, { name: "tone", description: "global tone", scope: "global", body: "g" });
    saveMemory(cwd, { name: "tone", description: "project tone", scope: "project", body: "p" });

    const all = listMemories(cwd);
    const tone = all.filter((m) => m.name === "tone");
    assert.equal(tone.length, 1);
    assert.equal(tone[0].scope, "project");
    assert.equal(tone[0].body, "p");

    // Both scope indexes recall.
    const ctx = loadMemoryContext(cwd)!;
    assert.match(ctx, /\(project\)/);
    assert.match(ctx, /\(global\)/);
  });
});

test("deleteMemory removes the file and rebuilds (or drops) the index", () => {
  withHome((cwd) => {
    const rec = saveMemory(cwd, { name: "ephemeral", description: "d", body: "b" });
    const indexPath = join(rec.path, "..", "MEMORY.md");
    assert.ok(existsSync(indexPath));

    const removed = deleteMemory(cwd, "ephemeral");
    assert.ok(removed);
    assert.ok(!existsSync(rec.path));
    // Last memory gone → index file is removed too.
    assert.ok(!existsSync(indexPath));
    assert.equal(loadMemoryContext(cwd), null);
    assert.equal(deleteMemory(cwd, "ephemeral"), null);
  });
});

function userMessage(text: string): ModelMessage {
  return { role: "user", content: text };
}

test("sessions round-trip: save, load by id, latest, and list newest-first", () => {
  withHome((cwd) => {
    const id1 = newSessionId();
    saveSession(cwd, id1, {
      modelSpec: "anthropic:claude-opus-4-8",
      messages: [userMessage("first session question")],
      usage: emptyUsage(),
    });
    // Ensure a distinct, later timestamp for ordering.
    const id2 = `${id1}-b`;
    saveSession(cwd, id2, {
      modelSpec: "anthropic:claude-opus-4-8",
      messages: [userMessage("second session question"), userMessage("more")],
      usage: emptyUsage(),
    });

    const loaded = loadSession(cwd, id1);
    assert.ok(loaded);
    assert.equal(loaded!.id, id1);
    assert.equal(loaded!.messages.length, 1);

    // latest.json mirrors the most recent write (back-compat for --continue).
    const latest = loadLatest(cwd);
    assert.ok(latest);
    assert.equal(latest!.id, id2);

    const metas = listSessions(cwd);
    assert.equal(metas.length, 2);
    assert.equal(metas[0].id, id2); // newest first
    assert.equal(metas[0].messageCount, 2);
    assert.match(metas[0].preview, /second session question/);
  });
});

test("loadLatest tolerates an id-less legacy file", () => {
  withHome((cwd) => {
    // Simulate an older latest.json written before sessions had ids.
    const dir = join(process.env.PRIVATEER_HOME!, "projects", projectKey(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "latest.json"),
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        modelSpec: "m",
        messages: [userMessage("legacy hi")],
        usage: emptyUsage(),
      }),
      "utf8",
    );
    const latest = loadLatest(cwd);
    assert.ok(latest);
    assert.ok(latest!.id, "readSessionFile should backfill a missing id");
    assert.equal(latest!.messages.length, 1);
  });
});
