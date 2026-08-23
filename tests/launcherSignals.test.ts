import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runToCompletion } from "../bin/run-to-completion.mjs";

// Regression: `privateer harbor` left its harbor running after the launcher stopped.
//
// Every subcommand re-execs a second Node process. The launcher forwarded nothing,
// so a plain `kill` — how launchd, systemd, a service wrapper or a script stops a
// process, and which reaches ONLY the launcher — killed the wrapper and reparented
// the harbor to init. It kept running and (measured 2026-08-23, building the E2E CLI
// fixture) kept its relay socket open, holding the account's live-agent slot: one, on
// the free plan, with no way to find the process except by pid. The harbor had
// handled SIGTERM correctly all along; nothing passed it on.
//
// `runToCompletion` was lifted out of the launcher to be testable here, for the same
// reason update-route.mjs was — the launcher runs on import, so nothing inside it can
// be exercised in place.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER = path.join(HERE, "..", "bin", "privateer-launch.mjs");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A long-lived child that records the signal it was asked to stop with. */
function stubChild(dir: string, opts: { ignoreTerm?: boolean } = {}): string {
  const file = path.join(dir, "child.mjs");
  fs.writeFileSync(file, [
    `import fs from "node:fs";`,
    `fs.writeFileSync(${JSON.stringify(path.join(dir, "started"))}, String(process.pid));`,
    opts.ignoreTerm
      ? `process.on("SIGTERM", () => {});`  // deliberately refuses to die
      : `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(path.join(dir, "stopped"))}, "term"); process.exit(0); });`,
    `setInterval(() => {}, 1000);`,
  ].join("\n"));
  return file;
}

/**
 * Run `runToCompletion` inside a throwaway process, so a real SIGTERM can be sent to
 * a real parent — the thing under test is what happens between two processes, and an
 * in-process call would have nothing to kill.
 */
function runParent(dir: string, childFile: string, forward: boolean) {
  const harness = path.join(dir, "harness.mjs");
  fs.writeFileSync(harness, [
    `import { runToCompletion } from ${JSON.stringify(path.join(HERE, "..", "bin", "run-to-completion.mjs"))};`,
    `runToCompletion(process.execPath, [${JSON.stringify(childFile)}], { forwardSignals: ${forward} });`,
  ].join("\n"));
  return spawn(process.execPath, [harness], { stdio: "ignore" });
}

async function waitForFile(p: string, ms = 10_000) {
  for (let i = 0; i < ms / 50 && !fs.existsSync(p); i++) await sleep(50);
  return fs.existsSync(p);
}

test("a stopped parent stops its child", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pv-sig-"));
  const parent = runParent(dir, stubChild(dir), true);

  assert.ok(await waitForFile(path.join(dir, "started")), "the child never started");
  const childPid = Number(fs.readFileSync(path.join(dir, "started"), "utf8"));
  assert.notEqual(childPid, parent.pid, "the child should be its own process");

  parent.kill("SIGTERM");

  assert.ok(await waitForFile(path.join(dir, "stopped")), "SIGTERM never reached the child");
  for (let i = 0; i < 100 && alive(childPid); i++) await sleep(50);
  assert.ok(!alive(childPid), `the child (pid ${childPid}) outlived its parent — the orphan is back`);
});

test("a child that ignores SIGTERM is killed rather than left behind", async () => {
  // The escalation matters as much as the forwarding: a wedged child that survives
  // its parent is the exact failure being fixed, and "we asked nicely" is not a fix.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pv-sig-hung-"));
  const parent = runParent(dir, stubChild(dir, { ignoreTerm: true }), true);

  assert.ok(await waitForFile(path.join(dir, "started")), "the child never started");
  const childPid = Number(fs.readFileSync(path.join(dir, "started"), "utf8"));

  parent.kill("SIGTERM");

  // SIGNAL_GRACE_MS is 5s; allow generously past it.
  for (let i = 0; i < 300 && alive(childPid); i++) await sleep(50);
  if (alive(childPid)) { try { process.kill(childPid, "SIGKILL"); } catch { /* ignore */ } }
  assert.ok(!alive(childPid), "a child ignoring SIGTERM was never escalated to SIGKILL");
});

test("without forwarding the child IS orphaned — the bug this fixes, pinned", async () => {
  // The negative control. Without it the two tests above could pass because of
  // something else entirely (a process group, the harness exiting, luck), and the
  // fix would look proven when it was not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pv-sig-off-"));
  const parent = runParent(dir, stubChild(dir), false);

  assert.ok(await waitForFile(path.join(dir, "started")), "the child never started");
  const childPid = Number(fs.readFileSync(path.join(dir, "started"), "utf8"));

  parent.kill("SIGTERM");
  await sleep(1500);

  assert.ok(alive(childPid), "expected the un-forwarded child to survive — has the default changed?");
  try { process.kill(childPid, "SIGKILL"); } catch { /* ignore */ }
});

test("the harbor and acp subcommands opt into forwarding; the TUI does not", () => {
  // The mechanism is only useful where it is switched on. Read from source so a
  // future edit that drops the flag fails here rather than in production.
  const src = fs.readFileSync(LAUNCHER, "utf8");
  const line = (needle: string) =>
    src.split("\n").find((l) => l.includes(needle) && l.includes("runToCompletion"));

  assert.ok(line("privateer-harbor.mjs")?.includes("forwardSignals: true"), "harbor does not forward");
  assert.ok(line("privateer-acp.mjs")?.includes("forwardSignals: true"), "acp does not forward");

  // SIGINT and SIGQUIT are terminal-generated and delivered to the whole foreground
  // process group, so the child has already had them. Forwarding would send a SECOND
  // — and a TUI that treats the first Ctrl-C as "clear the line" and the second as
  // "quit" would exit on one keypress.
  const tui = line("CLI, ...modelArgs");
  assert.ok(tui, "could not find the TUI launch line");
  assert.ok(!tui!.includes("forwardSignals"), "the TUI must not forward signals");
  const mod = fs.readFileSync(path.join(HERE, "..", "bin", "run-to-completion.mjs"), "utf8");
  const body = mod.slice(mod.indexOf("export function runToCompletion"));
  assert.ok(!/kill\("SIGINT"\)|"SIGINT"/.test(body.split("child.on")[0]), "must not forward SIGINT");
});
