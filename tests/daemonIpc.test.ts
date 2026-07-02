import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon/index.ts";
import { sendToDaemon, daemonSocketPath, DaemonNotRunningError } from "../src/daemon/ipc.ts";
import { Routine } from "../src/routines/schema.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSocket(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (existsSync(daemonSocketPath())) return;
    await sleep(25);
  }
  throw new Error("daemon socket never appeared");
}

test("daemon IPC: add/list/pause/resume/remove over the socket", async () => {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  const daemon = new Daemon();
  try {
    daemon.start();
    await waitForSocket();

    // status responds and reports our pid.
    const status = await sendToDaemon({ cmd: "status" });
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
    const added = await sendToDaemon({ cmd: "add", routine });
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
    const addedOnce = await sendToDaemon({ cmd: "add", routine: once });
    assert.equal(addedOnce.ok, true);
    assert.ok(addedOnce.routines?.find((r) => r.name === "reminder")?.nextRun);
    await sendToDaemon({ cmd: "remove", idOrName: "reminder" });

    // Reject a malformed trigger (no cron and no at).
    const bad = await sendToDaemon({ cmd: "add", routine: { ...routine, id: "r-2", cron: "nope" } });
    assert.equal(bad.ok, false);

    // pause clears enabled + nextRun.
    const paused = await sendToDaemon({ cmd: "pause", idOrName: "morning-news" });
    assert.equal(paused.ok, true);
    assert.equal(paused.routines?.[0].enabled, false);

    const resumed = await sendToDaemon({ cmd: "resume", idOrName: "morning-news" });
    assert.equal(resumed.routines?.[0].enabled, true);
    assert.ok(resumed.routines?.[0].nextRun);

    const removed = await sendToDaemon({ cmd: "remove", idOrName: "morning-news" });
    assert.equal(removed.ok, true);
    assert.equal(removed.routines?.length, 0);
  } finally {
    daemon.stop();
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("daemon IPC: sendToDaemon rejects when no daemon is running", async () => {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    await assert.rejects(() => sendToDaemon({ cmd: "status" }, 1000), DaemonNotRunningError);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
