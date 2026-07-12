import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRoutinesControl } from "../src/remote/routinesControl.ts";
import { loadRoutines, findRoutine, upsertRoutine } from "../src/routines/store.ts";
import { Routine } from "../src/routines/schema.ts";

// Run `fn` with a throwaway PRIVATEER_HOME so the store reads/writes an isolated
// routines.json, restoring the env after.
function withHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    fn(home);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("routinesControl: create validates + schedules, list reflects it", () => {
  withHome((home) => {
    const ctrl = makeRoutinesControl({ defaultCwd: () => home });
    const res = ctrl.save({ name: "morning-news", cron: "0 8 * * *", prompt: "summarize the news" });
    assert.ok(res.ok, res.message);

    const items = ctrl.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].name, "morning-news");
    assert.equal(items[0].cwd, home); // defaulted
    assert.deepEqual(items[0].delivery, ["file"]); // defaulted
    assert.ok(items[0].enabled);
    assert.ok(items[0].nextRun, "a cron routine gets a nextRun");
    assert.ok(items[0].id.startsWith("r-"));
  });
});

test("routinesControl: create rejects a bad cron and a bad delivery channel", () => {
  withHome((home) => {
    const ctrl = makeRoutinesControl({ defaultCwd: () => home });
    assert.equal(ctrl.save({ name: "x", cron: "not a cron", prompt: "hi" }).ok, false);
    // Neither cron nor at (exactly-one rule).
    assert.equal(ctrl.save({ name: "x", prompt: "hi" }).ok, false);
    // Both cron and at.
    assert.equal(ctrl.save({ name: "x", cron: "0 8 * * *", at: "2026-07-02T15:00:00", prompt: "hi" }).ok, false);
    // Unknown delivery channel.
    assert.equal(ctrl.save({ name: "x", cron: "0 8 * * *", prompt: "hi", delivery: ["carrier-pigeon"] }).ok, false);
    // Empty name / prompt.
    assert.equal(ctrl.save({ name: "  ", cron: "0 8 * * *", prompt: "hi" }).ok, false);
    assert.equal(ctrl.save({ name: "x", cron: "0 8 * * *", prompt: "  " }).ok, false);
    assert.deepEqual(ctrl.list(), []); // nothing persisted
  });
});

test("routinesControl: webhook delivery honors the injected existence check", () => {
  withHome((home) => {
    const ctrl = makeRoutinesControl({
      defaultCwd: () => home,
      webhookExists: (name) => name === "ops",
    });
    assert.equal(ctrl.save({ name: "a", cron: "0 8 * * *", prompt: "p", delivery: ["webhook:ops"] }).ok, true);
    assert.equal(ctrl.save({ name: "b", cron: "0 8 * * *", prompt: "p", delivery: ["webhook:unknown"] }).ok, false);
  });
});

test("routinesControl: edit preserves id + run bookkeeping, updates fields", () => {
  withHome((home) => {
    const ctrl = makeRoutinesControl({ defaultCwd: () => home });
    ctrl.save({ name: "job", cron: "0 8 * * *", prompt: "old" });
    const before = ctrl.list()[0];
    // Simulate a prior run leaving bookkeeping on disk.
    upsertRoutine({ ...(findRoutine(loadRoutines(), before.id) as Routine), lastRun: "2026-07-10T00:00:00Z", lastStatus: "ok" });

    const res = ctrl.save({ id: before.id, name: "job", cron: "0 9 * * *", prompt: "new" });
    assert.ok(res.ok, res.message);
    const after = ctrl.list()[0];
    assert.equal(after.id, before.id); // same id
    assert.equal(after.prompt, "new"); // updated
    assert.equal(after.cron, "0 9 * * *");
    assert.equal(after.lastRun, "2026-07-10T00:00:00Z"); // bookkeeping preserved
    assert.equal(after.lastStatus, "ok");
    assert.equal(ctrl.list().length, 1); // edit, not a new row
  });
});

test("routinesControl: rename collision is rejected, self-rename allowed", () => {
  withHome((home) => {
    const ctrl = makeRoutinesControl({ defaultCwd: () => home });
    ctrl.save({ name: "alpha", cron: "0 8 * * *", prompt: "p" });
    ctrl.save({ name: "beta", cron: "0 8 * * *", prompt: "p" });
    const beta = ctrl.list().find((r) => r.name === "beta")!;
    // Renaming beta → alpha collides.
    assert.equal(ctrl.save({ id: beta.id, name: "alpha", cron: "0 8 * * *", prompt: "p" }).ok, false);
    // Editing beta while keeping its own name is fine.
    assert.equal(ctrl.save({ id: beta.id, name: "beta", cron: "0 8 * * *", prompt: "p2" }).ok, true);
  });
});

test("routinesControl: setEnabled toggles nextRun; remove works", () => {
  withHome((home) => {
    const ctrl = makeRoutinesControl({ defaultCwd: () => home });
    ctrl.save({ name: "job", cron: "0 8 * * *", prompt: "p" });
    const id = ctrl.list()[0].id;

    assert.ok(ctrl.setEnabled(id, false).ok);
    let r = ctrl.list()[0];
    assert.equal(r.enabled, false);
    assert.equal(r.nextRun, undefined); // paused → no scheduled run

    assert.ok(ctrl.setEnabled(id, true).ok);
    r = ctrl.list()[0];
    assert.equal(r.enabled, true);
    assert.ok(r.nextRun); // resumed → rescheduled

    assert.equal(ctrl.setEnabled("nope", true).ok, false);
    assert.ok(ctrl.remove("job").ok);
    assert.deepEqual(ctrl.list(), []);
    assert.equal(ctrl.remove("job").ok, false);
  });
});

test("routinesControl: run invokes runNow with the resolved routine", () => {
  withHome((home) => {
    const ran: string[] = [];
    const ctrl = makeRoutinesControl({ defaultCwd: () => home, runNow: (r) => ran.push(r.name) });
    ctrl.save({ name: "job", at: "2026-07-02T15:00:00", prompt: "p" });
    assert.ok(ctrl.run("job").ok);
    assert.deepEqual(ran, ["job"]);
    // No runNow injected → run reports unavailable rather than throwing.
    const ctrl2 = makeRoutinesControl({ defaultCwd: () => home });
    assert.equal(ctrl2.run("job").ok, false);
  });
});

test("routinesControl: list is ordered by soonest nextRun, paused last", () => {
  withHome((home) => {
    const ctrl = makeRoutinesControl({ defaultCwd: () => home });
    ctrl.save({ name: "later", cron: "0 23 * * *", prompt: "p" });
    ctrl.save({ name: "sooner", cron: "*/5 * * * *", prompt: "p" });
    ctrl.save({ name: "paused", cron: "0 8 * * *", prompt: "p" });
    ctrl.setEnabled("paused", false);
    const names = ctrl.list().map((r) => r.name);
    assert.equal(names[names.length - 1], "paused"); // no nextRun → last
    assert.ok(names.indexOf("sooner") < names.indexOf("later"));
  });
});
