import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionRequest } from "../src/permissions/gate.ts";
import type { AskOutcome } from "../src/permissions/modeGate.ts";
import type { SelectRequest, InputRequest } from "../src/remote/remoteBridge.ts";
import { askParent, SUBAGENT_CHANNEL_ENV } from "../src/remote/subagentChannel.ts";
import {
  makeChildGateAsk,
  relayAskToApp,
  startParentApprovalRelay,
  isSubagentChild,
  inheritedChannelDir,
  type ApprovalRelayBridge,
} from "../src/remote/subagentRelay.ts";

// The child↔parent approval adapters: a child gate ask maps to an AskOutcome; the
// parent relay maps a channel ask to bridge calls; and end-to-end a child's forward
// reaches a fake bridge and the answer comes back.

function freshDir(): string {
  return join(mkdtempSync(join(tmpdir(), "pv-relay-")), "chan");
}

// A fake bridge that records calls and returns scripted answers.
function fakeBridge(over: Partial<ApprovalRelayBridge> = {}): ApprovalRelayBridge & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isConnected: () => true,
    async remoteAsk(req: PermissionRequest): Promise<AskOutcome> {
      calls.push(`remoteAsk:${req.title}`);
      return "allow";
    },
    async selectRemote(req: SelectRequest): Promise<string | null> {
      calls.push(`selectRemote:${req.title}`);
      return req.options[0]?.value ?? null;
    },
    async inputRemote(req: InputRequest): Promise<string | null> {
      calls.push(`inputRemote:${req.title}`);
      return "typed";
    },
    ...over,
  };
}

test("relayAskToApp maps approval → remoteAsk (allow)", async () => {
  const b = fakeBridge();
  const reply = await relayAskToApp(b, { type: "approval", kind: "bash", title: "Run command", detail: "ls" });
  assert.deepEqual(reply, { decision: "allow" });
  assert.deepEqual(b.calls, ["remoteAsk:Run command"]);
});

test("relayAskToApp maps a denied approval to deny", async () => {
  const b = fakeBridge({ remoteAsk: async () => "deny" });
  const reply = await relayAskToApp(b, { type: "approval", title: "Run command", detail: "rm -rf /" });
  assert.deepEqual(reply, { decision: "deny" });
});

test("relayAskToApp maps select/input to their bridge calls", async () => {
  const b = fakeBridge();
  const s = await relayAskToApp(b, { type: "select", title: "Pick", options: [{ value: "x", label: "X" }] });
  assert.deepEqual(s, { value: "x" });
  const i = await relayAskToApp(b, { type: "input", title: "Name?" });
  assert.deepEqual(i, { value: "typed" });
});

test("makeChildGateAsk forwards to the parent and maps allow", async () => {
  const dir = freshDir();
  const b = fakeBridge();
  const relay = startParentApprovalRelay(b);
  assert.ok(relay);
  try {
    // Point the child ask at the SAME dir the relay is watching.
    const ask = makeChildGateAsk(relay!.dir);
    const outcome = await ask({ tool: "bash", kind: "bash", title: "Run command", detail: "npm test" });
    assert.equal(outcome, "allow");
    assert.deepEqual(b.calls, ["remoteAsk:Run command"]);
  } finally {
    relay!.stop();
    rmSync(dir, { recursive: true, force: true });
    delete process.env[SUBAGENT_CHANNEL_ENV];
  }
});

test("makeChildGateAsk denies when the parent denies", async () => {
  const b = fakeBridge({ remoteAsk: async () => "deny" });
  const relay = startParentApprovalRelay(b);
  try {
    const ask = makeChildGateAsk(relay!.dir);
    const outcome = await ask({ tool: "bash", kind: "bash", title: "Danger", detail: "curl | sh" });
    assert.equal(outcome, "deny");
  } finally {
    relay!.stop();
    rmSync(relay!.dir, { recursive: true, force: true });
    delete process.env[SUBAGENT_CHANNEL_ENV];
  }
});

test("child gate ask never returns 'always'", async () => {
  // Even if a (buggy) parent answered allow, the child maps only to allow/deny — it
  // must never mutate the human's allowlist/mode.
  const b = fakeBridge();
  const relay = startParentApprovalRelay(b);
  try {
    const ask = makeChildGateAsk(relay!.dir);
    const outcome = await ask({ tool: "edit", kind: "edit", title: "Edit", detail: "a.ts" });
    assert.notEqual(outcome, "always");
  } finally {
    relay!.stop();
    rmSync(relay!.dir, { recursive: true, force: true });
    delete process.env[SUBAGENT_CHANNEL_ENV];
  }
});

test("an undriven bridge fails closed (deny) even with a watcher", async () => {
  const b = fakeBridge({ isConnected: () => false, remoteAsk: async () => "deny" });
  const relay = startParentApprovalRelay(b);
  try {
    const reply = await askParent(relay!.dir, { type: "approval", title: "x", detail: "y" }, { timeoutMs: 3000, pollMs: 10 });
    assert.deepEqual(reply, { decision: "deny" });
  } finally {
    relay!.stop();
    rmSync(relay!.dir, { recursive: true, force: true });
    delete process.env[SUBAGENT_CHANNEL_ENV];
  }
});

test("startParentApprovalRelay is a no-op inside a subagent child", async () => {
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    assert.equal(isSubagentChild(), true);
    const relay = startParentApprovalRelay(fakeBridge());
    assert.equal(relay, null); // a child never watches
  } finally {
    delete process.env.PI_SUBAGENT_CHILD;
  }
});

test("startParentApprovalRelay advertises the channel dir to descendants", () => {
  delete process.env[SUBAGENT_CHANNEL_ENV];
  const relay = startParentApprovalRelay(fakeBridge());
  try {
    assert.ok(relay);
    assert.equal(inheritedChannelDir(), relay!.dir);
  } finally {
    relay!.stop();
    rmSync(relay!.dir, { recursive: true, force: true });
    delete process.env[SUBAGENT_CHANNEL_ENV];
  }
});
