// PRIVATEER_HOME must point somewhere disposable before the paths module resolves
// (globalDir reads it lazily) — pickerCatalog reads hasCredentials(), which reads
// credentialsPath() under it. A fresh dir = a signed-out machine.
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-model-catalog-test";
// The shim is irrelevant to these cases and starting one would bind a socket.
process.env.PRIVATEER_SEALED = "0";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import {
  hiddenAccountNotice,
  hiddenAccountTitleSuffix,
  pickerCatalog,
} from "../src/providers/modelCatalog.ts";
import { clearCredentials, saveCredentials } from "../src/auth/privateer.ts";
import { globalDir } from "../src/config/paths.ts";

const m = (spec: string) => {
  const at = spec.indexOf("/");
  return { provider: spec.slice(0, at), id: spec.slice(at + 1) };
};

/** A stand-in for Pi's registry: everything registered, a subset with auth. */
const registry = (all: string[], available: string[]) => ({
  getAll: () => all.map(m),
  getAvailable: () => available.map(m),
});

// clearCredentials(), not just rm: a successfully-read credential is memoized in
// this module (only a NEGATIVE read re-checks disk), so deleting the file behind the
// cache would leave the next test still "signed in".
function signedOut() {
  rmSync(process.env.PRIVATEER_HOME!, { recursive: true, force: true });
  mkdirSync(globalDir(), { recursive: true });
  clearCredentials();
}

function signedIn() {
  signedOut();
  saveCredentials({ user: { id: "u1" }, refreshToken: "r" } as any);
}

const ACCOUNT = [
  "privateer/near/deepseek-ai/DeepSeek-V4-Flash",
  "privateer/tinfoil/glm-5-2",
  "privateer/anthropic/claude-opus-5",
];
const BYO = ["openrouter/anthropic/claude-opus-5", "ollama/llama3.1"];

test("offers what has auth, and counts the account models it could not", async () => {
  signedOut();
  const cat = await pickerCatalog(registry([...ACCOUNT, ...BYO], BYO));
  assert.deepEqual(cat.specs, [...BYO].sort());
  assert.equal(cat.hiddenAccountModels, 3);
  assert.equal(cat.signedIn, false);
});

test("nothing hidden once the account channel is armed", async () => {
  signedIn();
  const cat = await pickerCatalog(registry([...ACCOUNT, ...BYO], [...ACCOUNT, ...BYO]));
  assert.equal(cat.hiddenAccountModels, 0);
  assert.equal(cat.signedIn, true);
  assert.equal(hiddenAccountNotice(cat, "Run /login."), null);
  assert.equal(hiddenAccountTitleSuffix(cat), "");
});

test("a signed-out box is told it's signed out, not that we lack the models", async () => {
  signedOut();
  const cat = await pickerCatalog(registry([...ACCOUNT, ...BYO], BYO));
  const notice = hiddenAccountNotice(cat, "Run /login.")!;
  assert.match(notice, /^Not signed in/);
  assert.match(notice, /3 Privateer account models/);
  assert.match(notice, /confidential TEE/);
  assert.match(notice, /Run \/login\./);
  assert.equal(hiddenAccountTitleSuffix(cat), " · sign in for 3 more");
});

test("signed in but unarmed is a different sentence — the login isn't the fix", async () => {
  signedIn();
  const cat = await pickerCatalog(registry([...ACCOUNT, ...BYO], BYO));
  const notice = hiddenAccountNotice(cat, "Sign in from Account → Sign In…")!;
  assert.match(notice, /isn't armed/);
  assert.doesNotMatch(notice, /^Not signed in/);
});

test("singular reads as a sentence, and an empty registry says nothing", async () => {
  signedOut();
  const one = await pickerCatalog(registry([ACCOUNT[0], ...BYO], BYO));
  assert.match(hiddenAccountNotice(one, "Run /login.")!, /1 Privateer account model \(/);

  const none = await pickerCatalog(registry([], []));
  assert.deepEqual(none.specs, []);
  assert.equal(none.hiddenAccountModels, 0);
  assert.equal(hiddenAccountNotice(none, "Run /login."), null);
});

test("a registry that isn't there yet is empty, not a crash", async () => {
  signedOut();
  const cat = await pickerCatalog(null);
  assert.deepEqual(cat.specs, []);
  assert.equal(cat.hiddenAccountModels, 0);
});
