import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver, webhookBody } from "../src/routines/delivery.ts";
import { drainNotices, routineOutputDir } from "../src/routines/store.ts";
import { Routine, type DeliveryEntry } from "../src/routines/schema.ts";

async function withHome(fn: () => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

function routine(delivery: DeliveryEntry[]): Routine {
  return Routine.parse({ id: "r-1", name: "news", cron: "0 8 * * *", prompt: "p", cwd: "/tmp", delivery });
}

// A fetch stub that records requests and returns the given status.
function fakeFetch(status: number, calls: { url: string; body: string }[]): typeof fetch {
  return (async (url: any, init?: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as typeof fetch;
}

test("delivery: file writes latest.md and leaves no notice", async () => {
  await withHome(async () => {
    const report = await deliver(routine(["file"]), "# result\n", "ok");
    assert.ok(report.delivered.includes("file"));
    assert.ok(existsSync(join(routineOutputDir("news"), "latest.md")));
    assert.equal(drainNotices().length, 0);
  });
});

test("delivery: relay push live needs no notice backstop", async () => {
  await withHome(async () => {
    let pushed: string | undefined;
    const report = await deliver(routine(["relay"]), "hello world", "ok", {
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

test("delivery: relay queued (app closed) is durable — no notice needed", async () => {
  await withHome(async () => {
    const report = await deliver(routine(["relay"]), "x", "ok", { pushRelay: () => "queued" });
    assert.ok(report.delivered.includes("relay(queued)"));
    assert.equal(drainNotices().length, 0); // the daemon persisted it to the pending queue
  });
});

test("delivery: relay with no pusher wired falls back to a notice", async () => {
  await withHome(async () => {
    const report = await deliver(routine(["relay"]), "x", "ok", {}); // no pushRelay
    assert.ok(report.delivered.some((d) => d.startsWith("notice")));
    assert.equal(drainNotices().length, 1); // not lost
  });
});

test("delivery: relay + file records both, no backstop notice", async () => {
  await withHome(async () => {
    const report = await deliver(routine(["relay", "file"]), "x", "ok", { pushRelay: () => "live" });
    assert.ok(report.delivered.includes("relay"));
    assert.ok(report.delivered.includes("file"));
    assert.equal(drainNotices().length, 0);
  });
});

// --- cloud outbox ----------------------------------------------------------------

test("delivery: cloud sent needs no notice backstop", async () => {
  await withHome(async () => {
    let seen: { content: string; status: string } | undefined;
    const report = await deliver(routine(["cloud"]), "hello", "ok", {
      pushCloud: async (_r, content, status) => {
        seen = { content, status };
        return "sent";
      },
    });
    assert.deepEqual(seen, { content: "hello", status: "ok" });
    assert.ok(report.delivered.includes("cloud"));
    assert.equal(drainNotices().length, 0);
  });
});

test("delivery: cloud queued (offline) is durable — no notice", async () => {
  await withHome(async () => {
    const report = await deliver(routine(["cloud"]), "x", "error", { pushCloud: async () => "queued" });
    assert.ok(report.delivered.includes("cloud(queued)"));
    assert.equal(drainNotices().length, 0); // the daemon buffered it to pending-cloud
  });
});

test("delivery: cloud with no pusher wired falls back to a notice", async () => {
  await withHome(async () => {
    const report = await deliver(routine(["cloud"]), "x", "ok", {}); // no pushCloud
    assert.ok(report.delivered.some((d) => d.startsWith("notice")));
    assert.equal(drainNotices().length, 1); // not lost
  });
});

test("delivery: cloud + file records both, no backstop notice", async () => {
  await withHome(async () => {
    const report = await deliver(routine(["cloud", "file"]), "x", "ok", { pushCloud: async () => "queued" });
    assert.ok(report.delivered.includes("cloud(queued)"));
    assert.ok(report.delivered.includes("file"));
    assert.equal(drainNotices().length, 0);
  });
});

test("schema: cloud is a valid delivery channel", () => {
  const base = { id: "r-1", name: "x", cron: "0 8 * * *", prompt: "hi", cwd: "/tmp" };
  const r = Routine.parse({ ...base, delivery: ["cloud", "file"] });
  assert.deepEqual(r.delivery, ["cloud", "file"]);
});

// --- webhooks --------------------------------------------------------------------

test("delivery: webhook posts the redacted body to the named endpoint", async () => {
  await withHome(async () => {
    const calls: { url: string; body: string }[] = [];
    const report = await deliver(routine(["webhook:team"]), "key is sk-verysecretvalue1234 done", "ok", {
      webhooks: { team: { url: "https://hooks.example.com/x", format: "slack" } },
      redact: (t) => t.replace("sk-verysecretvalue1234", "«redacted»"),
      fetchImpl: fakeFetch(200, calls),
    });
    assert.deepEqual(report.delivered, ["webhook:team"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://hooks.example.com/x");
    const body = JSON.parse(calls[0].body);
    assert.match(body.text, /«redacted»/);
    assert.ok(!calls[0].body.includes("sk-verysecretvalue1234"), "secret never leaves");
    assert.match(body.text, /\*news\* \(ok\)/); // slack wrapping
    assert.equal(drainNotices().length, 0);
  });
});

test("delivery: failed or unconfigured webhook leaves a notice", async () => {
  await withHome(async () => {
    // HTTP failure → (failed) + notice.
    const failed = await deliver(routine(["webhook:team"]), "x", "ok", {
      webhooks: { team: { url: "https://hooks.example.com/x" } },
      fetchImpl: fakeFetch(500, []),
    });
    assert.deepEqual(failed.delivered, ["webhook:team(failed)"]);
    assert.equal(drainNotices().length, 1);

    // Name missing from config → (unconfigured) + notice, no fetch attempted.
    const calls: { url: string; body: string }[] = [];
    const missing = await deliver(routine(["webhook:nope"]), "x", "ok", {
      webhooks: {},
      fetchImpl: fakeFetch(200, calls),
    });
    assert.deepEqual(missing.delivered, ["webhook:nope(unconfigured)"]);
    assert.equal(calls.length, 0);
    assert.equal(drainNotices().length, 1);
  });
});

test("delivery: webhookBody wraps per format and enforces caps", () => {
  const r = { name: "news" };
  const slack = JSON.parse(webhookBody({ url: "https://x", format: "slack" }, r, "hello", "ok"));
  assert.match(slack.text, /\*news\*.*\nhello/s);
  const discord = JSON.parse(webhookBody({ url: "https://x", format: "discord" }, r, "y".repeat(5000), "error"));
  assert.ok(discord.content.length <= 2000, "discord cap respected");
  assert.match(discord.content, /…truncated/);
  const json = JSON.parse(webhookBody({ url: "https://x" }, r, "body", "ok"));
  assert.equal(json.routine, "news");
  assert.equal(json.status, "ok");
  assert.equal(json.content, "body");
});

test("schema: webhook delivery entries validate", () => {
  const base = { id: "r-1", name: "x", cron: "0 8 * * *", prompt: "hi", cwd: "/tmp" };
  const r = Routine.parse({ ...base, delivery: ["file", "webhook:team-slack"] });
  assert.deepEqual(r.delivery, ["file", "webhook:team-slack"]);
  assert.throws(() => Routine.parse({ ...base, delivery: ["webhook:"] })); // empty name
  assert.throws(() => Routine.parse({ ...base, delivery: ["webhook:has space"] }));
  assert.throws(() => Routine.parse({ ...base, delivery: ["pigeon"] })); // unknown channel
});
