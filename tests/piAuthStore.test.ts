// Point Pi's agent dir at a disposable directory BEFORE the module resolves paths.
process.env.PI_CODING_AGENT_DIR = "/private/tmp/claude-501/pv-piauthstore-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { modelRegistryOf, piAuthStore } from "../src/providers/piAuthStore.ts";

// These tests drive the REAL store — pi's own AuthStorage over a real auth.json — not a
// fake. account.test.ts covers the ownership RULES with a stand-in; this covers the thing
// a stand-in cannot: that we are actually talking to Pi's store, in Pi's file, and that a
// write from outside this process is visible to us.
//
// That last property is the one the exit teardown is built on. auth.json is machine-global
// and every terminal on the box shares it, so `dropPersistedAccountCredential` decides
// whether to delete an entry by reading back what is on disk. If our reads were served
// from a stale in-process copy, that check would compare against our own last write and
// happily delete a live terminal's credential — the exact regression the ownership check
// exists to prevent.

const DIR = process.env.PI_CODING_AGENT_DIR!;
const AUTH = join(DIR, "auth.json");

function freshDir(): void {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
}

test("writes land in Pi's auth.json, in Pi's format", async () => {
  freshDir();
  const store = await piAuthStore();
  const cred = { type: "oauth", access: "a1", refresh: "r1", expires: Date.now() + 3_600_000 };
  await store.modify("privateer", async () => cred);

  assert.ok(existsSync(AUTH), "the store must persist to auth.json, not just memory");
  const onDisk = JSON.parse(readFileSync(AUTH, "utf8"));
  assert.deepEqual(onDisk.privateer, cred, "keyed by provider id at the top level");
  assert.deepEqual(await store.read("privateer"), cred, "and reads back through the store");
});

// The load-bearing one. A second Privateer terminal arming its own session rewrites this
// file underneath us; our next read has to see ITS entry, not our last write.
test("read() sees a write made outside this process", async () => {
  freshDir();
  const store = await piAuthStore();
  await store.modify("privateer", async () => ({ type: "oauth", access: "ours" }));

  const raw = JSON.parse(readFileSync(AUTH, "utf8"));
  raw.privateer = { type: "oauth", access: "other-terminal" };
  writeFileSync(AUTH, JSON.stringify(raw, null, 2));

  const seen = (await store.read("privateer")) as { access?: string } | undefined;
  assert.equal(
    seen?.access,
    "other-terminal",
    "a stale in-process copy here would let the exit teardown delete a live terminal's credential",
  );
});

test("delete() removes the entry and leaves other providers alone", async () => {
  freshDir();
  const store = await piAuthStore();
  await store.modify("anthropic", async () => ({ type: "api", key: "keep-me" }));
  await store.modify("privateer", async () => ({ type: "oauth", access: "drop-me" }));

  await store.delete("privateer");

  assert.equal(await store.read("privateer"), undefined);
  assert.deepEqual(
    await store.read("anthropic"),
    { type: "api", key: "keep-me" },
    "a BYO provider key must survive the account teardown",
  );
});

test("modify() returning undefined leaves the entry untouched", async () => {
  freshDir();
  const store = await piAuthStore();
  const cred = { type: "oauth", access: "a1" };
  await store.modify("privateer", async () => cred);
  await store.modify("privateer", async () => undefined);
  assert.deepEqual(await store.read("privateer"), cred);
});

// modelRegistryOf duck-types off the live runtime rather than constructing Pi's
// ModelRegistry, because importing that class would drag Pi into a static graph that has
// to stay Pi-free (see the module header). Pin the delegation so a future edit that
// "simplifies" it back to the class is caught here.
test("modelRegistryOf delegates to the runtime and tolerates a missing one", async () => {
  const calls: string[] = [];
  const registry = modelRegistryOf({
    modelRuntime: {
      getModel: (p: string, id: string) => { calls.push(`getModel:${p}/${id}`); return { provider: p, id }; },
      getModels: () => { calls.push("getModels"); return [{ id: "m1" }]; },
      getAvailable: async () => { calls.push("getAvailable"); return [{ id: "m2" }]; },
    },
  });

  assert.deepEqual(registry.find("privateer", "x"), { provider: "privateer", id: "x" });
  assert.deepEqual(registry.getAll(), [{ id: "m1" }]);
  assert.deepEqual(await registry.getAvailable(), [{ id: "m2" }]);
  assert.deepEqual(calls, ["getModel:privateer/x", "getModels", "getAvailable"]);

  // Services without a runtime must degrade to empty rather than throw: callers use this
  // on paths (a failed session bootstrap) where the model list is best-effort.
  const empty = modelRegistryOf(undefined);
  assert.equal(empty.find("p", "i"), undefined);
  assert.deepEqual(empty.getAll(), []);
  assert.deepEqual(await empty.getAvailable(), []);
});
