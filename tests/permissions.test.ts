import { test } from "node:test";
import assert from "node:assert/strict";
import { decideAuto, isAllowlisted } from "../src/permissions/mode.ts";
import { ModeGate, type AskOutcome } from "../src/permissions/uiGate.ts";
import type { PermissionRequest } from "../src/permissions/gate.ts";
import type { PermissionMode } from "../src/config/schema.ts";

const edit: PermissionRequest = { tool: "edit", kind: "edit", title: "Edit file", detail: "a.ts" };
const bash = (cmd: string): PermissionRequest => ({ tool: "bash", kind: "bash", title: "Run", detail: cmd });

test("isAllowlisted matches command prefixes", () => {
  const allow = ["git status", "ls"];
  assert.equal(isAllowlisted("git status", allow), true);
  assert.equal(isAllowlisted("git status --short", allow), true);
  assert.equal(isAllowlisted("git push", allow), false);
  assert.equal(isAllowlisted("lsof", allow), false); // not a prefix-with-space match
});

test("decideAuto follows the mode policy", () => {
  assert.equal(decideAuto(edit, "bypass", []), "allow");
  assert.equal(decideAuto(edit, "plan", []), "deny");
  assert.equal(decideAuto(edit, "acceptEdits", []), "allow");
  assert.equal(decideAuto(edit, "default", []), "ask");
  assert.equal(decideAuto(bash("ls"), "acceptEdits", []), "ask"); // edits auto, bash still asks
  assert.equal(decideAuto(bash("ls"), "default", ["ls"]), "allow"); // allowlisted
});

test("protected files always prompt, even under acceptEdits", () => {
  const guarded: PermissionRequest = { ...edit, detail: ".env", protected: true };
  assert.equal(decideAuto(guarded, "acceptEdits", []), "ask");
  assert.equal(decideAuto(guarded, "default", []), "ask");
  // bypass is explicitly "no prompts", so it still allows.
  assert.equal(decideAuto(guarded, "bypass", []), "allow");
});

test("fetch is a network read: allowed-with-prompt in plan, asks otherwise", () => {
  const fetchReq: PermissionRequest = { tool: "web_fetch", kind: "fetch", title: "Fetch", detail: "https://x" };
  assert.equal(decideAuto(fetchReq, "plan", []), "ask"); // plan denies mutations but permits network reads
  assert.equal(decideAuto(fetchReq, "default", []), "ask");
  assert.equal(decideAuto(fetchReq, "bypass", []), "allow");
});

test("outside-cwd access always prompts, except under bypass", () => {
  const outsideReq: PermissionRequest = { ...edit, detail: "/elsewhere/a.ts", outside: true, path: "/elsewhere/a.ts" };
  assert.equal(decideAuto(outsideReq, "acceptEdits", []), "ask"); // not auto-approved by acceptEdits
  assert.equal(decideAuto(outsideReq, "default", []), "ask");
  assert.equal(decideAuto(outsideReq, "bypass", []), "allow"); // bypass means no prompts
});

function makeGate(initialMode: PermissionMode, answer: AskOutcome) {
  let mode = initialMode;
  const allowlist: string[] = [];
  const allowedOutsideRoots: string[] = [];
  let asks = 0;
  const gate = new ModeGate({
    getMode: () => mode,
    setMode: (m) => (mode = m),
    allowlist,
    allowedOutsideRoots,
    ask: async () => {
      asks++;
      return answer;
    },
  });
  return { gate, allowlist, allowedOutsideRoots, asks: () => asks, mode: () => mode };
}

test("gate auto-allows in bypass without asking", async () => {
  const g = makeGate("bypass", "deny");
  assert.equal(await g.gate.request(edit), "allow");
  assert.equal(g.asks(), 0);
});

test("gate denies in plan without asking", async () => {
  const g = makeGate("plan", "allow");
  assert.equal(await g.gate.request(bash("rm -rf /")), "deny");
  assert.equal(g.asks(), 0);
});

test("gate asks in default and honors deny", async () => {
  const g = makeGate("default", "deny");
  assert.equal(await g.gate.request(edit), "deny");
  assert.equal(g.asks(), 1);
});

test("'always' on bash remembers the command", async () => {
  const g = makeGate("default", "always");
  assert.equal(await g.gate.request(bash("npm test")), "allow");
  assert.deepEqual(g.allowlist, ["npm test"]);
  // Second time it's allowlisted, so no further ask.
  assert.equal(await g.gate.request(bash("npm test")), "allow");
  assert.equal(g.asks(), 1);
});

test("'always' on edit switches to acceptEdits", async () => {
  const g = makeGate("default", "always");
  assert.equal(await g.gate.request(edit), "allow");
  assert.equal(g.mode(), "acceptEdits");
});

test("'always' on outside access remembers the directory, not the edit mode", async () => {
  const g = makeGate("default", "always");
  const outsideReq: PermissionRequest = {
    tool: "edit", kind: "edit", title: "Edit outside", detail: "/repo/b/a.ts", outside: true, path: "/repo/b/a.ts",
  };
  assert.equal(await g.gate.request(outsideReq), "allow");
  assert.deepEqual(g.allowedOutsideRoots, ["/repo/b"]); // remembers the containing dir
  assert.equal(g.mode(), "default"); // does NOT relax to acceptEdits
});
