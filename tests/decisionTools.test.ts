import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools, createReadOnlyTools } from "../src/tools/index.ts";
import { autoApproveGate } from "../src/permissions/gate.ts";
import { exec } from "../src/tools/exec.ts";
import type { UserAnswer, UserAsker } from "../src/tools/askUser.ts";

function setup(extra?: Partial<Parameters<typeof createTools>[0]>) {
  const cwd = mkdtempSync(join(tmpdir(), "privateer-dec-"));
  const tools: any = createTools({ cwd, gate: autoApproveGate, ...extra });
  const run = (name: string, args: any) => tools[name].execute(args, { toolCallId: "t", messages: [] });
  return { cwd, tools, run, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

const QUESTION = {
  question: "Which cache?",
  options: [{ label: "Redis" }, { label: "In-memory", description: "simpler" }],
};

test("ask_user relays a selected option back to the model", async () => {
  const asker: UserAsker = async () => ({ kind: "selected", indices: [0] });
  const { run, cleanup } = setup({ askUser: asker });
  try {
    const out = await run("ask_user", QUESTION);
    assert.match(out, /The user chose: "Redis"/);
  } finally {
    cleanup();
  }
});

test("ask_user passes a custom answer through verbatim", async () => {
  const asker: UserAsker = async () => ({ kind: "custom", text: "do neither" });
  const { run, cleanup } = setup({ askUser: asker });
  try {
    const out = await run("ask_user", QUESTION);
    assert.match(out, /The user answered: do neither/);
  } finally {
    cleanup();
  }
});

test("ask_user reports a dismissal so the model can proceed", async () => {
  const asker: UserAsker = async () => ({ kind: "dismissed" } as UserAnswer);
  const { run, cleanup } = setup({ askUser: asker });
  try {
    const out = await run("ask_user", QUESTION);
    assert.match(out, /dismissed the question/);
  } finally {
    cleanup();
  }
});

test("ask_user degrades gracefully with no interactive channel", async () => {
  const { run, cleanup } = setup(); // no askUser in ctx
  try {
    const out = await run("ask_user", QUESTION);
    assert.match(out, /Cannot ask the user interactively/);
  } finally {
    cleanup();
  }
});

test("ask_user and worktree are not exposed to read-only sub-agents", () => {
  const cwd = mkdtempSync(join(tmpdir(), "privateer-ro-"));
  try {
    const ro: any = createReadOnlyTools({ cwd, gate: autoApproveGate });
    assert.equal(ro.ask_user, undefined);
    assert.equal(ro.worktree, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("worktree create / list / remove round-trips in a git repo", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "privateer-wt-"));
  const allowedOutsideRoots: string[] = [];
  const tools: any = createTools({ cwd, gate: autoApproveGate, allowedOutsideRoots });
  const run = (name: string, args: any) => tools[name].execute(args, { toolCallId: "t", messages: [] });
  try {
    // Initialize a repo with one commit so HEAD exists.
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "t@t.t"],
      ["config", "user.name", "T"],
    ]) {
      await exec("git", args, { cwd, timeoutMs: 30_000 });
    }
    writeFileSync(join(cwd, "f.txt"), "hi\n");
    await exec("git", ["add", "-A"], { cwd, timeoutMs: 30_000 });
    await exec("git", ["commit", "-qm", "init"], { cwd, timeoutMs: 30_000 });

    const created = await run("worktree", { action: "create", name: "try cache!" });
    assert.match(created, /Created worktree/);
    assert.match(created, /branch 'try-cache'/);
    // The new worktree's path was registered so the agent can edit there.
    assert.equal(allowedOutsideRoots.length, 1);
    assert.ok(existsSync(allowedOutsideRoots[0]));

    const listed = await run("worktree", { action: "list" });
    assert.match(listed, /try-cache/);

    const removed = await run("worktree", { action: "remove", name: "try cache!", deleteBranch: true });
    assert.match(removed, /Removed worktree/);
    assert.match(removed, /Deleted branch 'try-cache'/);
    assert.equal(allowedOutsideRoots.length, 0);
  } finally {
    // Clean up any sibling worktree dir left behind on failure.
    rmSync(cwd, { recursive: true, force: true });
    rmSync(`${cwd}-wt-try-cache`, { recursive: true, force: true });
  }
});

test("worktree requires a name for create", async () => {
  const { run, cleanup } = setup();
  try {
    const out = await run("worktree", { action: "create" });
    assert.match(out, /non-empty `name`/);
  } finally {
    cleanup();
  }
});
