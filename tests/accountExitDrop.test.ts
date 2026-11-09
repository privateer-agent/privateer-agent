import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dropPersistedAccountCredentialBeforeExit,
  rememberAccountCredential,
} from "../src/providers/account.ts";
import { piAuthStore, setPiAuthStoreForTests, type PiCredentialStore } from "../src/providers/piAuthStore.ts";

const ENTRY = { access: "ours", refresh: "our-r", expires: Date.now() + 3_600_000 };

function store(over: Partial<PiCredentialStore>): PiCredentialStore {
  return { read: async () => undefined, modify: async () => undefined, delete: async () => {}, ...over };
}

// Pi calls process.exit as soon as session_shutdown handlers return, so this promise
// resolving is the only thing standing between a finished drop and an abandoned one.
test("the exit drop has finished by the time it resolves", async (t) => {
  t.after(() => setPiAuthStoreForTests(undefined));
  let deleted = false;
  setPiAuthStoreForTests(
    store({
      read: async () => ({ type: "oauth", ...ENTRY }),
      delete: async () => {
        await new Promise((r) => setTimeout(r, 50));
        deleted = true;
      },
    }),
  );
  rememberAccountCredential(ENTRY);
  await dropPersistedAccountCredentialBeforeExit();
  assert.equal(deleted, true);
});

test("the exit drop gives up rather than hang the quit", async (t) => {
  t.after(() => setPiAuthStoreForTests(undefined));
  setPiAuthStoreForTests(store({ read: () => new Promise(() => {}) })); // a lock that is never released
  const started = Date.now();
  await dropPersistedAccountCredentialBeforeExit(50);
  assert.ok(Date.now() - started < 1_000, "quitting must not wait on another process's lock");
});

test("the exit drop swallows store errors", async (t) => {
  t.after(() => setPiAuthStoreForTests(undefined));
  setPiAuthStoreForTests(
    store({
      read: async () => {
        throw new Error("unwritable");
      },
    }),
  );
  await dropPersistedAccountCredentialBeforeExit();
});

// The regression itself, against Pi's real store: no lock directory left on disk.
test("the exit drop leaves no lock behind on Pi's real auth store", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privateer-exit-drop-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    setPiAuthStoreForTests(undefined);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  setPiAuthStoreForTests(undefined);
  const authFile = path.join(dir, "auth.json");
  fs.writeFileSync(authFile, JSON.stringify({ privateer: { type: "oauth", ...ENTRY } }));
  rememberAccountCredential(ENTRY);
  await piAuthStore(); // already loaded by the time a real session quits

  await dropPersistedAccountCredentialBeforeExit();

  assert.equal(fs.existsSync(`${authFile}.lock`), false, "an orphaned lock freezes the next launch for 30s");
  assert.equal(JSON.parse(fs.readFileSync(authFile, "utf8")).privateer, undefined);
});
