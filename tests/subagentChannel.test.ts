import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askParent,
  watchSubagentChannel,
  channelDirForSession,
  ensureChannelDir,
  type SubagentAsk,
} from "../src/remote/subagentChannel.ts";

// The child→parent approval relay: a headless subagent's gate ask travels to the
// parent over files and the answer comes back. Fail-closed on every non-answer.

function freshDir(): string {
  return join(mkdtempSync(join(tmpdir(), "pv-subch-")), "chan");
}

test("channelDirForSession is deterministic and sanitizes the id", () => {
  const a = channelDirForSession("sess-123");
  assert.equal(a, channelDirForSession("sess-123"));
  // No path separators leak from a hostile session id.
  const b = channelDirForSession("../../etc/passwd");
  assert.ok(!b.includes(".." + "/"), "traversal stripped");
});

test("approval ask round-trips: parent answers allow", async () => {
  const dir = freshDir();
  const seen: SubagentAsk[] = [];
  const w = watchSubagentChannel(dir, async (ask) => {
    seen.push(ask);
    return { decision: "allow" };
  }, { pollMs: 10 });
  try {
    const reply = await askParent(dir, { type: "approval", title: "Run bash", detail: "rm -rf x" }, { pollMs: 10, timeoutMs: 5000 });
    assert.deepEqual(reply, { decision: "allow" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, "approval");
  } finally {
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("select ask round-trips: parent returns the chosen value", async () => {
  const dir = freshDir();
  const w = watchSubagentChannel(dir, async (ask) => {
    assert.equal(ask.type, "select");
    return { value: "b" };
  }, { pollMs: 10 });
  try {
    const reply = await askParent(dir, { type: "select", title: "Pick", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }, { pollMs: 10, timeoutMs: 5000 });
    assert.deepEqual(reply, { value: "b" });
  } finally {
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no parent watching → times out to null (fail closed)", async () => {
  const dir = freshDir();
  ensureChannelDir(dir);
  const reply = await askParent(dir, { type: "approval", title: "Run bash", detail: "ls" }, { pollMs: 10, timeoutMs: 120 });
  assert.equal(reply, null);
  rmSync(dir, { recursive: true, force: true });
});

test("abort resolves to null promptly", async () => {
  const dir = freshDir();
  const ac = new AbortController();
  const p = askParent(dir, { type: "approval", title: "x", detail: "y" }, { pollMs: 10, timeoutMs: 5000, signal: ac.signal });
  ac.abort();
  assert.equal(await p, null);
  rmSync(dir, { recursive: true, force: true });
});

test("a throwing handler fails closed to deny and clears the request", async () => {
  const dir = freshDir();
  let errored = false;
  const w = watchSubagentChannel(dir, async () => {
    throw new Error("relay down");
  }, { pollMs: 10, onError: () => { errored = true; } });
  try {
    const reply = await askParent(dir, { type: "approval", title: "x", detail: "y" }, { pollMs: 10, timeoutMs: 5000 });
    assert.deepEqual(reply, { decision: "deny" });
    assert.ok(errored);
    // request file was consumed
    assert.equal(readdirSync(join(dir, "requests")).length, 0);
  } finally {
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handler runs at most once per request (no double-serve)", async () => {
  const dir = freshDir();
  let calls = 0;
  const w = watchSubagentChannel(dir, async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 60)); // slow handler spans several polls
    return { decision: "allow" };
  }, { pollMs: 10 });
  try {
    const reply = await askParent(dir, { type: "approval", title: "x", detail: "y" }, { pollMs: 10, timeoutMs: 5000 });
    assert.deepEqual(reply, { decision: "allow" });
    assert.equal(calls, 1);
  } finally {
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two concurrent asks are answered independently", async () => {
  const dir = freshDir();
  const w = watchSubagentChannel(dir, async (ask) => {
    return ask.type === "input" ? { value: (ask.title === "one" ? "1" : "2") } : { decision: "deny" };
  }, { pollMs: 10 });
  try {
    const [r1, r2] = await Promise.all([
      askParent(dir, { type: "input", title: "one" }, { pollMs: 10, timeoutMs: 5000 }),
      askParent(dir, { type: "input", title: "two" }, { pollMs: 10, timeoutMs: 5000 }),
    ]);
    assert.deepEqual(r1, { value: "1" });
    assert.deepEqual(r2, { value: "2" });
  } finally {
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
