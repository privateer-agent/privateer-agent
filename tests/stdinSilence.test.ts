import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression: `privateer -p "task"` hung forever, printing nothing, when whatever started
// it left stdin attached but silent. Found by running it under a benchmark harness.
//
// These drive Pi's real CLI with our patch applied. No model or key is configured, so each
// run ends in an error as soon as it gets past reading stdin, which is all they look at.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PI_CLI = path.join(HERE, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const FLAGS = ["-p", "--no-session", "--offline", "-ne", "-ns", "-np", "-nc"];
const STILL_WAITING = "Still waiting for piped stdin";
const CONTINUING = "continuing without it";
const HANG_LIMIT_MS = 25_000;
const skip = process.platform === "win32" ? "needs a POSIX shell" : false;

interface Outcome {
  exited: boolean;
  stderr: string;
  elapsedMs: number;
}

function isolatedEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privateer-stdin-"));
  return { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir };
}

function observe(child: ChildProcess, killAfterMs: number): Promise<Outcome> {
  const started = Date.now();
  let stderr = "";
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  child.stdout!.resume();
  return new Promise((resolve) => {
    let exited = true;
    const timer = setTimeout(() => {
      exited = false;
      child.kill("SIGKILL");
    }, killAfterMs);
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ exited, stderr, elapsedMs: Date.now() - started });
    });
  });
}

function runWithSilentSocket(args: string[], killAfterMs: number): Promise<Outcome> {
  // Node's "pipe" is a socket on POSIX, and nothing here ever writes to or closes it.
  const child = spawn(process.execPath, [PI_CLI, ...FLAGS, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: isolatedEnv(),
  });
  return observe(child, killAfterMs);
}

function runInShellPipeline(producer: string): Promise<Outcome> {
  const cli = [process.execPath, PI_CLI, ...FLAGS, "hello"].map((part) => `'${part}'`).join(" ");
  const child = spawn("sh", ["-c", `${producer} | ${cli}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: isolatedEnv(),
  });
  return observe(child, HANG_LIMIT_MS);
}

test("a silent socket does not hang a run that already has a prompt", { skip }, async () => {
  const outcome = await runWithSilentSocket(["hello"], HANG_LIMIT_MS);
  assert.ok(outcome.exited, `hung; stderr: ${outcome.stderr}`);
  assert.match(outcome.stderr, new RegExp(CONTINUING));
});

test("a shell pipeline is waited for, however long it stays silent", { skip }, async () => {
  const silentMs = 7_000;
  const outcome = await runInShellPipeline(`sleep ${silentMs / 1000}`);
  assert.ok(outcome.exited, `hung; stderr: ${outcome.stderr}`);
  assert.ok(outcome.elapsedMs >= silentMs, `gave up after ${outcome.elapsedMs}ms`);
  assert.match(outcome.stderr, new RegExp(STILL_WAITING));
  assert.doesNotMatch(outcome.stderr, new RegExp(CONTINUING));
});

test("piped input that arrives promptly triggers no notice", { skip }, async () => {
  const outcome = await runInShellPipeline("printf payload");
  assert.ok(outcome.exited, `hung; stderr: ${outcome.stderr}`);
  assert.doesNotMatch(outcome.stderr, new RegExp(`${STILL_WAITING}|${CONTINUING}`));
});

test("with no prompt, stdin is the only input, so a silent socket is waited for", { skip }, async () => {
  const outcome = await runWithSilentSocket([], 6_000);
  assert.equal(outcome.exited, false, `exited early; stderr: ${outcome.stderr}`);
  assert.match(outcome.stderr, new RegExp(STILL_WAITING));
});
