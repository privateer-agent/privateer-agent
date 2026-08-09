import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The boot splash (bin/privateer-splash.mjs) covers the ~30s of silence between the
 * launcher's banner and Pi's first painted frame. Three things about it are load-bearing
 * and all three are invisible until someone launches a cold terminal, so they are pinned
 * here instead.
 */
const BIN = resolve(import.meta.dirname, "..", "bin");
const SPLASH = join(BIN, "privateer-splash.mjs");

test("splash: the launcher --imports it on the TUI branch, as a file URL", () => {
  const src = readFileSync(join(BIN, "privateer-launch.mjs"), "utf8");
  assert.match(
    src,
    /"--import",\s*pathToFileURL\(splash\)\.href/,
    "the splash must be passed as a file:// URL — a Windows absolute path reads as the " +
      "URL scheme \"d:\" (see tests/launcherImports.test.ts for the same trap)",
  );
  // It must go to Pi's TUI child and nothing else. `privateer acp` speaks JSON-RPC on
  // stdout and would be desynchronised by a single stray byte; harbor and the subagent
  // wrapper have no terminal to animate on.
  const splashAt = src.indexOf("privateer-splash.mjs");
  const cliAt = src.indexOf('const CLI = dep("@earendil-works/pi-coding-agent"');
  assert.ok(cliAt > 0 && splashAt > cliAt, "the splash belongs in the TUI branch only");
  for (const other of ["privateer-acp.mjs", "privateer-harbor.mjs", "privateer-subagent.mjs"]) {
    const otherSrc = readFileSync(join(BIN, other), "utf8");
    assert.ok(!otherSrc.includes("privateer-splash"), `${other} must not load the splash`);
  }
});

test("splash: the animation runs off the main thread", () => {
  const src = readFileSync(SPLASH, "utf8");
  // The first version of this used setInterval and animated NOTHING: Pi's boot is a
  // synchronous module-loading storm, so the main thread's event loop never gets a turn
  // between process start and the first frame — the timer's first tick landed after the
  // wait it was supposed to cover. Only a second thread can draw through that.
  assert.match(src, /new Worker\(/, "the wave must be drawn from a worker thread");
  assert.match(
    src,
    /Atomics\.(store|wait|notify)\(/,
    "main→worker signalling must be through SharedArrayBuffer atomics, which work while " +
      "the main thread is blocked (a postMessage would sit in an event loop that never runs)",
  );
});

test("splash: no terminal, no output", () => {
  // Piped stdio (CI, `privateer | tee`, a test harness) must see byte-for-byte what it
  // would see without the splash — no wave, no cursor escapes.
  const out = execFileSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(SPLASH).href,
      "-e",
      'process.stdout.write("hello"); process.stderr.write("warn")',
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] as const },
  );
  assert.equal(out, "hello");
});
