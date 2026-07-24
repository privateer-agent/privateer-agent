import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harbor } from "../src/harbor/index.ts";
import { sendToHarbor, harborSocketPath, HarborNotRunningError, HarborAlreadyRunningError } from "../src/harbor/ipc.ts";
import { Routine } from "../src/routines/schema.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSocket(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (existsSync(harborSocketPath())) return;
    await sleep(25);
  }
  throw new Error("harbor socket never appeared");
}

test("harbor IPC: add/list/pause/resume/remove over the socket", async () => {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  const harbor = new Harbor();
  try {
    await harbor.start();
    await waitForSocket();

    // status responds and reports our pid.
    const status = await sendToHarbor({ cmd: "status" });
    assert.equal(status.ok, true);
    assert.equal(status.pid, process.pid);

    // A far-future schedule so the tick loop never actually fires a model run.
    const routine = Routine.parse({
      id: "r-1",
      name: "morning-news",
      cron: "0 8 1 1 *", // 08:00 on Jan 1
      prompt: "summarize world news",
      cwd: home,
    });
    const added = await sendToHarbor({ cmd: "add", routine });
    assert.equal(added.ok, true);
    assert.equal(added.routines?.length, 1);
    assert.ok(added.routines?.[0].nextRun, "nextRun computed on add");

    // A far-future one-off is accepted and scheduled for its `at` time.
    const once = Routine.parse({
      id: "r-once",
      name: "reminder",
      at: "2099-01-01T09:00:00",
      prompt: "remind me",
      cwd: home,
    });
    const addedOnce = await sendToHarbor({ cmd: "add", routine: once });
    assert.equal(addedOnce.ok, true);
    assert.ok(addedOnce.routines?.find((r) => r.name === "reminder")?.nextRun);
    await sendToHarbor({ cmd: "remove", idOrName: "reminder" });

    // Reject a malformed trigger (no cron and no at).
    const bad = await sendToHarbor({ cmd: "add", routine: { ...routine, id: "r-2", cron: "nope" } });
    assert.equal(bad.ok, false);

    // pause clears enabled + nextRun.
    const paused = await sendToHarbor({ cmd: "pause", idOrName: "morning-news" });
    assert.equal(paused.ok, true);
    assert.equal(paused.routines?.[0].enabled, false);

    const resumed = await sendToHarbor({ cmd: "resume", idOrName: "morning-news" });
    assert.equal(resumed.routines?.[0].enabled, true);
    assert.ok(resumed.routines?.[0].nextRun);

    const removed = await sendToHarbor({ cmd: "remove", idOrName: "morning-news" });
    assert.equal(removed.ok, true);
    assert.equal(removed.routines?.length, 0);
  } finally {
    harbor.stop();
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("harbor single-instance: a second harbor on the same home refuses to start", async () => {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  const first = new Harbor();
  try {
    await first.start();
    await waitForSocket();
    // The first harbor holds the socket; a second under the same ~/.privateer must
    // detect the live listener and refuse rather than steal the path.
    const second = new Harbor();
    await assert.rejects(() => second.start(), HarborAlreadyRunningError);
    // The original is untouched and still answering.
    const status = await sendToHarbor({ cmd: "status" });
    assert.equal(status.ok, true);
    assert.equal(status.pid, process.pid);
  } finally {
    first.stop();
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("harbor IPC: sendToHarbor rejects when no harbor is running", async () => {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    await assert.rejects(() => sendToHarbor({ cmd: "status" }, 1000), HarborNotRunningError);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
