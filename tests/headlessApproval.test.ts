import { test } from "node:test";
import assert from "node:assert/strict";
import { HeadlessAppApprover, type HeadlessRelay } from "../src/remote/headlessApproval.ts";
import type { RelayCallbacks } from "../src/remote/relayClient.ts";
import type { PermissionRequest } from "../src/permissions/gate.ts";

// A relay standing in for the app. `attach` is the app opening this terminal.
function fakeRelay() {
  let cb: RelayCallbacks | undefined;
  let controller = false;
  let started = 0;
  let stopped = 0;
  const approvals: { id: string; req: PermissionRequest }[] = [];
  const notices: string[] = [];
  const relay: HeadlessRelay = {
    async start() { started++; },
    stop() { stopped++; },
    hasController: () => controller,
    isConnected: () => true,
    requestApproval: (id, req) => approvals.push({ id, req }),
    sendEvent() {}, sendNoQuarter() {}, sendPrivacy() {},
    async sendFile() { return { ok: true }; },
    sendNotice: (t) => notices.push(t),
    sendCommands() {}, requestSelect() {}, requestInput() {}, sendFileMatches() {},
    sendExtensions() {}, sendSkills() {}, requestCargoSave() {}, requestChartOp() {},
    async requestLibrarySave() {},
  };
  return {
    relay,
    approvals,
    notices,
    make: (callbacks: RelayCallbacks) => ((cb = callbacks), relay),
    attach() { controller = true; cb?.onControllerAttached?.(); },
    detach() { controller = false; cb?.onControllerDetached?.(); },
    answer(decision: "allow" | "deny") { cb!.onApprovalResponse!(approvals.at(-1)!.id, decision); },
    prompt(text: string) { cb!.onPrompt!(text); },
    counts: () => ({ started, stopped }),
  };
}

const req: PermissionRequest = { tool: "generate_video", kind: "write", title: "Generate a video", detail: "clip.mp4", alwaysAsk: true };
const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

test("waits for the app to attach, shows the price, and runs on Allow", async () => {
  const f = fakeRelay();
  const log: string[] = [];
  const a = new HeadlessAppApprover({ timeoutMs: 5_000, pollMs: 5, log: (l) => log.push(l), signedIn: () => true, makeRelay: f.make });
  assert.equal(f.counts().started, 0, "no socket until something needs approving");
  const pending = a.ask(req, undefined, "about $0.50");
  await until(() => f.counts().started === 1);
  assert.match(log.join("\n"), /Approval needed: Generate a video · about \$0\.50/);
  assert.equal(f.approvals.length, 0, "nothing is sent before the app is there to see it");
  f.attach();
  await until(() => f.approvals.length === 1);
  assert.equal(f.approvals[0].req.detail, "clip.mp4 · about $0.50");
  f.answer("allow");
  assert.equal(await pending, "allow");
  a.close();
  assert.equal(f.counts().stopped, 1);
});

test("a controller that leaves mid-ask is waited for, not taken as a Deny", async () => {
  const f = fakeRelay();
  const a = new HeadlessAppApprover({ timeoutMs: 5_000, pollMs: 5, log: () => {}, signedIn: () => true, makeRelay: f.make });
  const pending = a.ask(req);
  await until(() => f.counts().started === 1);
  f.attach();
  await until(() => f.approvals.length === 1);
  f.detach(); // phone locked
  f.attach(); // …and back
  await until(() => f.approvals.length === 2);
  f.answer("allow");
  assert.equal(await pending, "allow");
  a.close();
});

test("Deny in the app, a timeout, and a signed-out machine all deny", async () => {
  const f = fakeRelay();
  const log: string[] = [];
  const a = new HeadlessAppApprover({ timeoutMs: 5_000, pollMs: 5, log: (l) => log.push(l), signedIn: () => true, makeRelay: f.make });
  const p = a.ask(req);
  await until(() => f.counts().started === 1);
  f.attach();
  await until(() => f.approvals.length === 1);
  f.answer("deny");
  assert.equal(await p, "deny");
  assert.match(log.at(-1)!, /denied in the app/);
  a.close();

  const g = fakeRelay();
  const quiet = new HeadlessAppApprover({ timeoutMs: 60, pollMs: 5, log: (l) => log.push(l), signedIn: () => true, makeRelay: g.make });
  assert.equal(await quiet.ask(req), "deny");
  assert.match(log.at(-1)!, /no answer from the app/);
  quiet.close();

  const h = fakeRelay();
  const out = new HeadlessAppApprover({ timeoutMs: 60, log: (l) => log.push(l), signedIn: () => false, makeRelay: h.make });
  assert.equal(await out.ask(req), "deny");
  assert.equal(h.counts().started, 0, "never opens a relay without a login");
});

test("the app can't drive a headless run — a prompt is refused with a notice", async () => {
  const f = fakeRelay();
  const a = new HeadlessAppApprover({ timeoutMs: 60, pollMs: 5, log: () => {}, signedIn: () => true, makeRelay: f.make });
  const p = a.ask(req);
  await until(() => f.counts().started === 1);
  f.prompt("rm -rf everything");
  assert.match(f.notices[0], /approvals only/);
  await p;
  a.close();
});
