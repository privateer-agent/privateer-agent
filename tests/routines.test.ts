import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextRun, cronError, parseCron } from "../src/routines/cron.ts";
import { Routine, newRoutineId } from "../src/routines/schema.ts";
import { triggerError, computeNextRun, advanceAfterRun, describeTrigger } from "../src/routines/trigger.ts";
import {
  loadRoutines,
  upsertRoutine,
  removeRoutine,
  findRoutine,
  saveRoutines,
  routinesFilePath,
  writeRoutineOutput,
  routineOutputDir,
  addNotice,
  drainNotices,
  addPendingRelay,
  loadPendingRelay,
  drainPendingRelay,
  routineRelayId,
} from "../src/routines/store.ts";

test("cron: nextRun computes the next daily fire time", () => {
  // 08:00 daily, from 06:00 the same day → 08:00 that day.
  const from = new Date(2026, 0, 1, 6, 0, 0);
  const next = nextRun("0 8 * * *", from);
  assert.ok(next);
  assert.equal(next!.getHours(), 8);
  assert.equal(next!.getMinutes(), 0);
  assert.equal(next!.getDate(), 1);

  // From 09:00, the next 08:00 rolls to the following day.
  const next2 = nextRun("0 8 * * *", new Date(2026, 0, 1, 9, 0, 0));
  assert.ok(next2);
  assert.equal(next2!.getDate(), 2);
  assert.equal(next2!.getHours(), 8);
});

test("cron: strictly after `from` (never returns the current minute)", () => {
  const from = new Date(2026, 0, 1, 8, 0, 0);
  const next = nextRun("0 8 * * *", from);
  assert.equal(next!.getDate(), 2); // not today's 08:00 (already reached)
});

test("cron: steps, ranges, and lists parse and match", () => {
  // Every 15 minutes.
  const n = nextRun("*/15 * * * *", new Date(2026, 0, 1, 10, 3, 0));
  assert.equal(n!.getMinutes(), 15);

  // Range of hours + explicit minute.
  const f = parseCron("30 9-17 * * 1-5");
  assert.ok(f.hour.has(9) && f.hour.has(17) && !f.hour.has(8));
  assert.ok(f.dow.has(1) && f.dow.has(5) && !f.dow.has(0));
  assert.ok(f.minute.has(30) && f.minute.size === 1);
});

test("cron: named month/day and Sunday-as-7", () => {
  const f = parseCron("0 0 1 jan sun");
  assert.ok(f.month.has(1));
  assert.ok(f.dow.has(0));
  const g = parseCron("0 0 * * 7"); // 7 → Sunday
  assert.ok(g.dow.has(0));
});

test("cron: cronError flags malformed expressions", () => {
  assert.equal(cronError("0 8 * * *"), null);
  assert.ok(cronError("0 8 * *")); // too few fields
  assert.ok(cronError("99 8 * * *")); // out of range
});

test("trigger: validates, computes, and advances cron vs one-off", () => {
  // Validation: exactly one trigger.
  assert.ok(triggerError({})); // neither
  assert.ok(triggerError({ cron: "0 8 * * *", at: "2026-07-02T15:00:00" })); // both
  assert.equal(triggerError({ cron: "0 8 * * *" }), null);
  assert.equal(triggerError({ at: "2026-07-02T15:00:00" }), null);
  assert.ok(triggerError({ at: "not-a-date" }));

  // One-off computeNextRun returns the fixed `at` time (even if past → catch-up).
  const past = "2000-01-01T00:00:00";
  assert.equal(computeNextRun({ at: past })!.getTime(), new Date(past).getTime());

  // advanceAfterRun: cron reschedules; one-off disables itself.
  const cronRoutine = Routine.parse({ id: "r-1", name: "n", cron: "*/5 * * * *", prompt: "p", cwd: "/tmp" });
  assert.ok(advanceAfterRun(cronRoutine).nextRun);
  const onceRoutine = Routine.parse({ id: "r-2", name: "n", at: past, prompt: "p", cwd: "/tmp" });
  assert.deepEqual(advanceAfterRun(onceRoutine), { enabled: false, nextRun: undefined });

  assert.match(describeTrigger({ cron: "0 8 * * *" }), /0 8/);
  assert.match(describeTrigger({ at: "2026-07-02T15:00:00" }), /once @/);
});

test("schema: Routine applies defaults", () => {
  const r = Routine.parse({ id: "r-1", name: "x", cron: "0 8 * * *", prompt: "hi", cwd: "/tmp" });
  assert.deepEqual(r.delivery, ["file"]);
  assert.equal(r.enabled, true);
});

test("schema: exactly one of cron/at is required", () => {
  const base = { id: "r-1", name: "x", prompt: "hi", cwd: "/tmp" };
  assert.throws(() => Routine.parse({ ...base })); // neither
  assert.throws(() => Routine.parse({ ...base, cron: "0 8 * * *", at: "2026-07-02T15:00:00" })); // both
  assert.ok(Routine.parse({ ...base, at: "2026-07-02T15:00:00" })); // one-off ok
});

test("store: upsert/find/remove roundtrip and 0600 perms", () => {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    assert.deepEqual(loadRoutines(), []);
    const routine = Routine.parse({
      id: "r-1",
      name: "morning-news",
      cron: "0 8 * * *",
      prompt: "summarize world news",
      cwd: home,
    });
    upsertRoutine(routine);
    const all = loadRoutines();
    assert.equal(all.length, 1);
    assert.equal(all[0].name, "morning-news");

    // Update in place (same id → replace, not append).
    upsertRoutine({ ...routine, enabled: false });
    assert.equal(loadRoutines().length, 1);
    assert.equal(loadRoutines()[0].enabled, false);

    // Lookup by name is case-insensitive.
    assert.ok(findRoutine(loadRoutines(), "MORNING-NEWS"));

    // File is owner-only on POSIX.
    if (process.platform !== "win32") {
      assert.equal(statSync(routinesFilePath()).mode & 0o777, 0o600);
    }

    const removed = removeRoutine("morning-news");
    assert.ok(removed);
    assert.deepEqual(loadRoutines(), []);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("store: writeRoutineOutput writes latest.md + dated file", () => {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    const latest = writeRoutineOutput("Morning News", "# hello\n");
    assert.ok(existsSync(latest));
    assert.match(readFileSync(latest, "utf8"), /hello/);
    assert.equal(join(routineOutputDir("Morning News"), "latest.md"), latest);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("store: routineRelayId is stable, unique-format, and reused across calls", () => {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    const id = routineRelayId();
    assert.match(id, /^[A-Za-z0-9_-]{8,64}$/); // valid per server isValidTermId
    assert.ok(id.startsWith("routines-"));
    assert.equal(routineRelayId(), id); // persisted → same id on next call
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("store: pending-relay queue add + drain (survives as durable backlog)", () => {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    assert.deepEqual(loadPendingRelay(), []);
    addPendingRelay({ routine: "news", at: new Date().toISOString(), content: "morning summary" });
    addPendingRelay({ routine: "news", at: new Date().toISOString(), content: "second" });
    assert.equal(loadPendingRelay().length, 2);
    const drained = drainPendingRelay();
    assert.equal(drained.length, 2);
    assert.equal(drained[0].content, "morning summary"); // fire order preserved
    assert.deepEqual(loadPendingRelay(), []); // cleared after drain
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("store: notices queue add + drain (drain clears)", () => {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    assert.deepEqual(drainNotices(), []);
    addNotice({ routine: "r", at: new Date().toISOString(), status: "ok", preview: "done" });
    const drained = drainNotices();
    assert.equal(drained.length, 1);
    assert.equal(drained[0].preview, "done");
    assert.deepEqual(drainNotices(), []); // cleared
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// Regression: newRoutineId() was `r-${Date.now()}` with no entropy. Ids minted inside
// the same millisecond were identical, and since upsertRoutine keys on id, the second
// routine silently REPLACED the first — a user could create two routines in quick
// succession (an import, a scripted setup) and lose one with no error anywhere. It also
// made tests/routinesControl.test.ts fail at random, which is how it was found.
//
// Grouping by the embedded timestamp rather than timing the loop keeps this
// deterministic: however fast the machine is, some ids land in the same millisecond,
// and the assertion is about those ids specifically. (Timing the loop instead would
// make the test itself flaky on a slow or busy runner.)
test("newRoutineId: ids minted in the same millisecond are unique", () => {
  const ids = Array.from({ length: 5000 }, () => newRoutineId());

  // "r-<epochMs>-<random>" → group by the epoch segment.
  const byMillisecond = new Map<string, string[]>();
  for (const id of ids) {
    const ms = id.split("-")[1];
    byMillisecond.set(ms, [...(byMillisecond.get(ms) ?? []), id]);
  }

  const contended = [...byMillisecond.values()].filter((g) => g.length > 1);
  assert.ok(contended.length > 0, "sanity: the loop must mint several ids in one millisecond");
  for (const group of contended) {
    assert.equal(new Set(group).size, group.length, "ids sharing a millisecond must differ");
  }
});

test("newRoutineId: ids still sort by creation time", () => {
  // The timestamp prefix is what orders routines; the suffix must not disturb it.
  const first = newRoutineId();
  const clock = Date.now();
  while (Date.now() === clock) { /* spin into the next millisecond */ }
  const second = newRoutineId();
  assert.ok(first < second, `${first} should sort before ${second}`);
});
