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

test("splash: Windows consoles are switched to UTF-8 code page 65001", () => {
  // On Windows / PowerShell, raw fd 2 writes (fs.writeSync(2, ...)) use the console's
  // active Output Code Page. If left on OEM CP437, Unicode wave blocks and emojis turn
  // into 3-byte mojibake sequences that wrap across lines and flood the terminal.
  const cmdSrc = readFileSync(join(BIN, "privateer.cmd"), "utf8");
  assert.match(cmdSrc, /chcp\s+65001/, "privateer.cmd must switch console to UTF-8");

  const launchSrc = readFileSync(join(BIN, "privateer-launch.mjs"), "utf8");
  assert.match(
    launchSrc,
    /chcp.*\[["']65001["']\]/,
    "privateer-launch.mjs must set console code page 65001 on Windows",
  );

  const splashSrc = readFileSync(SPLASH, "utf8");
  assert.match(
    splashSrc,
    /chcp.*\[["']65001["']\]/,
    "privateer-splash.mjs must set console code page 65001 on Windows",
  );
});

test("splash: our own control sequences are written synchronously to fd 2", () => {
  // On Windows a write to a TTY stream is ASYNCHRONOUS — process.stderr.write only queues
  // the bytes for the event loop — and this whole file exists because Pi's boot never
  // gives the event loop a turn. Through the stream, every erase would land after the
  // output it was meant to clear, and the cursor restore on `exit` would never flush at
  // all: a console left with wave fragments in front of the first frame and no cursor.
  const src = readFileSync(SPLASH, "utf8");
  assert.match(src, /function writeCtl\(/, "the splash must write control bytes itself");
  assert.match(
    src,
    /fs\.writeSync\(2, buf, off\)/,
    "writeCtl must go straight to fd 2, the same descriptor the drawing thread uses",
  );
  // The erase, the cursor restore and the EIO bail-out are the three writes that must not
  // be queued. errWrite survives only as the passthrough for Pi's own stderr.
  for (const seq of [String.raw`\r\x1b[K`, String.raw`\x1b[?25h`]) {
    assert.ok(
      src.includes(`writeCtl("${seq}")`),
      `${seq} must be written with writeCtl, not through process.stderr`,
    );
  }
  assert.equal(
    src.match(/errWrite\(/g)?.length,
    1,
    "errWrite is called in exactly one place: passing Pi's own stderr through",
  );
});

test("splash: legacy Windows consoles get glyphs their font actually has", () => {
  // chcp 65001 settles the encoding, not the font. A plain cmd.exe/PowerShell window
  // defaults to Lucida Console or a raster font, which carries the CP437 block elements
  // (█ ▄ ▀ ░ ▒ ▓) and nothing else — the eighth-block ramp, ⚓ and … are all missing
  // there, so the wave drew as a row of tofu that changed shape every frame.
  const src = readFileSync(SPLASH, "utf8");
  const legacy = src.match(/const legacyConsole =([\s\S]*?);\n/)?.[1];
  assert.ok(legacy, "expected a legacyConsole detection block");
  assert.match(legacy, /win32/, "the fallback is Windows-only");
  for (const modern of ["WT_SESSION", "TERM_PROGRAM", "ConEmuANSI", "ANSICON", "TERM"]) {
    assert.match(legacy, new RegExp(modern), `${modern} announces a console with a real font`);
  }

  const ramps = src.match(/const BLOCKS = legacyConsole \? "([^"]*)" : "([^"]*)"/);
  assert.ok(ramps, "expected both ramps on one line");
  const [, fallback, blocks] = ramps;
  const chars = (s: string) => [...s.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))];
  assert.equal(chars(fallback).length, 8, "the fallback must keep all eight levels");
  assert.equal(chars(blocks).length, 8);
  // U+2581..U+2587 are the ones Lucida Console lacks; U+2588 (full block) it has.
  for (const ch of chars(fallback)) {
    const cp = ch.codePointAt(0)!;
    assert.ok(
      cp === 0x20 || cp === 0x2588 || (cp >= 0x2591 && cp <= 0x2593),
      `U+${cp.toString(16)} is not in CP437 — a legacy console cannot draw it`,
    );
  }
});
