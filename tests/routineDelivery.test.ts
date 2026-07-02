import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver } from "../src/routines/delivery.ts";
import { drainNotices, routineOutputDir } from "../src/routines/store.ts";
import { Routine } from "../src/routines/schema.ts";

function withHome(fn: () => void): void {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

function routine(delivery: ("file" | "relay" | "notice" | "email")[]): Routine {
  return Routine.parse({ id: "r-1", name: "news", cron: "0 8 * * *", prompt: "p", cwd: "/tmp", delivery });
}

test("delivery: file writes latest.md and leaves no notice", () => {
  withHome(() => {
    const report = deliver(routine(["file"]), "# result\n", "ok");
    assert.ok(report.delivered.includes("file"));
    assert.ok(existsSync(join(routineOutputDir("news"), "latest.md")));
    assert.equal(drainNotices().length, 0);
  });
});

test("delivery: relay push live needs no notice backstop", () => {
  withHome(() => {
    let pushed: string | undefined;
    const report = deliver(routine(["relay"]), "hello world", "ok", {
      pushRelay: (_r, content) => {
        pushed = content;
        return "live";
      },
    });
    assert.equal(pushed, "hello world"); // real-time push happened
    assert.ok(report.delivered.includes("relay"));
    assert.equal(drainNotices().length, 0); // live delivery is durable enough
  });
});

test("delivery: relay queued (app closed) is durable — no notice needed", () => {
  withHome(() => {
    const report = deliver(routine(["relay"]), "x", "ok", { pushRelay: () => "queued" });
    assert.ok(report.delivered.includes("relay(queued)"));
    assert.equal(drainNotices().length, 0); // the daemon persisted it to the pending queue
  });
});

test("delivery: relay with no pusher wired falls back to a notice", () => {
  withHome(() => {
    const report = deliver(routine(["relay"]), "x", "ok", {}); // no pushRelay
    assert.ok(report.delivered.some((d) => d.startsWith("notice")));
    assert.equal(drainNotices().length, 1); // not lost
  });
});

test("delivery: relay + file records both, no backstop notice", () => {
  withHome(() => {
    const report = deliver(routine(["relay", "file"]), "x", "ok", { pushRelay: () => "live" });
    assert.ok(report.delivered.includes("relay"));
    assert.ok(report.delivered.includes("file"));
    assert.equal(drainNotices().length, 0);
  });
});
