/**
 * Two harbor bookkeeping paths that lost or repeated work on a resident machine.
 *
 *  - The cloud-outbox flush loaded the queue, awaited the network, then saved its own
 *    snapshot: a result queued while it was posting was deleted, and two overlapping
 *    flushes (one starts every tick) posted the same items twice.
 *  - runRoutine had no finally: a throw in delivery left the routine marked running
 *    forever, or — as an unhandled rejection — crashed the harbor before nextRun
 *    advanced, so the restart fired (and billed) the same routine again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harbor } from "../src/harbor/index.ts";
import { addPendingCloud, loadPendingCloud, loadRoutines, upsertRoutine } from "../src/routines/store.ts";
import { clearCredentials } from "../src/auth/privateer.ts";

async function inTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "priv-run-safety-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  // Signed in (flush is a no-op otherwise), against a loopback port nothing listens on.
  writeFileSync(
    join(home, "credentials.json"),
    JSON.stringify({ accessToken: "a", refreshToken: "r", user: { id: "u" }, serverBaseUrl: "http://127.0.0.1:1" }),
  );
  try {
    await fn(home);
  } finally {
    clearCredentials();
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

const item = (routine: string) => ({ routine, at: "2026-10-02T00:00:00.000Z", status: "ok" as const, content: `${routine} body` });

test("outbox flush: overlapping flushes post each item once, and keep what was queued meanwhile", () =>
  inTempHome(async () => {
    addPendingCloud(item("a"));
    addPendingCloud(item("b"));
    const posted: string[] = [];
    const harbor = new Harbor() as any;
    harbor.postOutbox = async (name: string) => {
      posted.push(name);
      // A run finishes while the flush is mid-post and queues its own result.
      if (name === "a") addPendingCloud(item("late"));
      await new Promise((r) => setTimeout(r, 10));
      return name !== "late"; // pretend the late one can't be sealed yet
    };
    await Promise.all([harbor.flushPendingCloud(), harbor.flushPendingCloud()]);
    assert.deepEqual(posted, ["a", "b"], "no duplicates from the second, overlapping flush");
    assert.deepEqual(loadPendingCloud().map((p) => p.routine), ["late"], "the result queued mid-flush survived");
  }));

test("runRoutine: a delivery failure frees the slot and still advances the schedule", () =>
  inTempHome(async (home) => {
    upsertRoutine({
      id: "r-1",
      name: "daily",
      cron: "0 7 * * *",
      prompt: "hi",
      cwd: home,
      delivery: ["file"],
      enabled: true,
      nextRun: "2026-10-01T07:00:00.000Z",
    });
    // Make file delivery throw: the routine's output dir is a regular file.
    mkdirSync(join(home, "routines"), { recursive: true });
    writeFileSync(join(home, "routines", "daily"), "not a directory");

    const harbor = new Harbor() as any;
    harbor.runSession = async () => ({ out: "result", status: "ok", notes: [] });
    const res = await harbor.runRoutine(loadRoutines()[0]);

    assert.equal(res.ok, false);
    assert.equal(harbor.running.size, 0, "the routine can fire again");
    const after = loadRoutines()[0];
    assert.equal(after.lastStatus, "error");
    assert.match(after.lastError ?? "", /delivery failed/);
    assert.ok(after.nextRun && Date.parse(after.nextRun) > Date.parse("2026-10-01T07:00:00.000Z"), "nextRun moved on");
  }));
