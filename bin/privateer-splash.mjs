// Boot splash — the wave that runs while Pi's TUI is still coming up.
//
// WHY THIS EXISTS. A cold `privateer` measured ~30s between the shell prompt and the
// first painted frame, all of it silent:
//
//   0.1s   launcher banner (the login/keyless notice) — the last thing the user sees
//   ~11s   Pi's own module graph loads (bare `pi` with zero extensions costs this)
//   ~19s   …plus the 16 moat/tool-pack extensions we pass as `-e`
//   ~30s   session_start handlers finish and the TUI paints its first frame
//
// Worse than the wait is its shape: Pi enables raw mode and HIDES THE CURSOR at the
// ~19s mark, so the last third is a terminal with no prompt, no cursor and no output.
// Every report of this reads as "privateer hangs".
//
// Loaded with `node --import` (see the TUI branch of bin/privateer-launch.mjs) so it
// runs BEFORE Pi's entry module — the module loading it covers is most of the wait, and
// a splash started any later would miss it.
//
// WHY A WORKER THREAD. The first version of this drew from a setInterval and animated
// nothing: Pi's boot is a synchronous module-loading storm (compileSourceTextModule,
// readFileUtf8, the CJS lexer — see the profile), so the main thread's event loop never
// gets a turn between here and the first frame. A timer that only fires once the wait is
// over is not a loading indicator. The animation therefore lives on its own thread, with
// its own loop, which keeps drawing while the main thread is wedged. The main thread
// still owns the two things that must be synchronous — noticing Pi's output and getting
// out of its way — and steers the worker through a SharedArrayBuffer.
//
// HOW IT KNOWS WHEN TO STOP. Nothing tells us "the TUI is up", so we watch Pi's own
// output: process.stdout is patched here, before Pi ever touches it. Two signals:
//   • `\x1b[?2004h` (bracketed paste) — TUI.start(). Raw mode is on, the cursor is
//     hidden, extensions' session_start handlers are now running. The wave switches to
//     its second message and keeps going; the first frame is still seconds away.
//   • ≥ FRAME_BYTES of stdout AFTER that point — the first frame is being written. We
//     stop the worker, erase the line and get out of the way in the same tick, before
//     the frame reaches the terminal.
// Anything else Pi writes (a stray log line) just clears our line first, so the wave
// never lands in front of real output.
//
// The wave is drawn on STDERR; stdout belongs to the TUI's canvas.
//
// WHY EVERY WRITE OF OURS IS fs.writeSync. On Windows a write to a TTY stream is
// ASYNCHRONOUS — process.stderr.write only queues the bytes for the event loop — and the
// whole point of this file is that Pi's boot never gives the event loop a turn. Through
// process.stderr, every erase we issue during the wait would land after the output it was
// meant to clear, and the cursor restore on `exit` would never flush at all: a Windows
// console left with wave fragments in front of Pi's first frame and no cursor afterwards.
// fs.writeSync goes straight to fd 2, which is also what the drawing thread uses, so the
// two threads' output stays in the order it was issued. Pi's OWN stderr still goes
// through the stream — that write belongs to the caller, return value and all.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

const enabled =
  process.stdout.isTTY &&
  process.stderr.isTTY &&
  !process.env.PRIVATEER_NO_SPLASH &&
  !process.env.CI;

// On Windows, ensure the console output code page is UTF-8 (65001) before the worker
// thread starts drawing. If privateer was launched via npm/npx or direct node rather
// than privateer.cmd, the console might still be on OEM CP437.
if (enabled && process.platform === "win32") {
  try {
    const comspec = process.env.ComSpec || "cmd.exe";
    spawnSync(comspec, ["/d", "/s", "/c", "chcp 65001 >nul"], { stdio: "inherit", windowsHide: true });
  } catch {
    /* best effort */
  }
}

// WHICH GLYPHS THE CONSOLE CAN ACTUALLY DRAW. Code page 65001 above settles the ENCODING;
// it says nothing about the FONT. Legacy conhost — a plain cmd.exe or PowerShell window,
// which is still what `privateer` gets when it isn't launched from Windows Terminal —
// defaults to Lucida Console or a raster font, and those cover exactly the CP437 block
// elements (█ ▄ ▀ ░ ▒ ▓) and nothing else. The eighth-block ramp, the anchor and the
// ellipsis are all absent there, so the "wave" drew as a row of tofu boxes that changed
// shape every frame. Every modern host announces itself in the environment (Windows
// Terminal, VS Code, ConEmu/ANSICON, anything mintty-ish that sets TERM), and on those the
// eighth blocks are the better picture, so the fallback is only for the ones that don't.
const legacyConsole =
  process.platform === "win32" &&
  !(
    process.env.WT_SESSION ||
    process.env.WT_PROFILE_ID ||
    process.env.TERM_PROGRAM ||
    process.env.ConEmuANSI ||
    process.env.ANSICON ||
    process.env.TERM
  );

// Eight levels either way, so the wave keeps its shape: height where the font has the
// eighth blocks, density where it only has the CP437 shades.
const BLOCKS = legacyConsole ? " \u2591\u2591\u2592\u2592\u2593\u2593\u2588" : "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
const ANCHOR = legacyConsole ? "~" : "\u2693";
const ELLIPSIS = legacyConsole ? "..." : "\u2026";

// Bytes of stdout after TUI.start() that mean "this is the first frame, not a control
// sequence". Everything Pi writes between raw mode and the frame is short (the paste
// toggle, a Kitty protocol query, the cursor hide, an OSC window title — 42 bytes all
// told on the run this was measured from); the frame itself is thousands.
const FRAME_BYTES = 200;

// Nothing is shown for this long. A launch that fails fast (`--help`, a flag Pi
// rejects, a broken install) is done well inside it and never sees a wave flash across
// its output.
const HOLD_MS = 600;

if (enabled) {
  const err = process.stderr;
  const errWrite = err.write.bind(err);
  const outWrite = process.stdout.write.bind(process.stdout);

  // Shared state, the only channel to the drawing thread. Slots, in order: stop
  // requested / which message to draw / the worker has stopped and will not write
  // again / the worker has drawn at least once (so there is a line to erase and a
  // hidden cursor to restore).
  const STOP = 0, PHASE = 1, ACK = 2, DREW = 3;
  const sab = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(sab);

  // Room for "  ⚓ " + wave + " " + message + ellipsis + elapsed, clamped so a narrow
  // terminal doesn't wrap (a wrapped line survives our `\r\x1b[K` erase only on its last
  // row). The reserve is measured rather than guessed, because the pieces are no longer
  // fixed: the anchor is TWO cells wherever ⚓ keeps its emoji presentation, one where it
  // fell back to ASCII, and the ellipsis is one cell or three.
  const MSGS = ["hoisting sail", "raising the colours"];
  const anchorCells = ANCHOR === "\u2693" ? 2 : 1; // U+2693 carries emoji presentation
  const reserve =
    2 + anchorCells + 1 + 1 + Math.max(...MSGS.map((m) => m.length)) + ELLIPSIS.length + 5;
  const cols = err.columns && err.columns > 0 ? err.columns : 80;
  const width = Math.max(6, Math.min(28, cols - reserve));

  // The worker source is plain logic with no escape sequences of its own — every ANSI
  // string is handed over in workerData, so nothing here has to survive two rounds of
  // backslash escaping.
  const worker = new Worker(
    `
    const fs = require("node:fs");
    const { workerData: w } = require("node:worker_threads");
    const s = new Int32Array(w.sab);
    const STOP = 0, PHASE = 1, ACK = 2, DREW = 3;
    const t0 = Date.now();
    let frame = 0;

    // A swell travelling right to left, in eighth-blocks. Two summed sines at different
    // wavelengths — one sine on its own reads as a metronome. Two-tone rather than a
    // per-cell gradient, so a frame is a handful of escapes and not one per column.
    function wave(phase) {
      let out = "", tone = "";
      for (let x = 0; x < w.width; x++) {
        const y = (Math.sin(x * 0.45 - phase) * 0.65 + Math.sin(x * 0.21 - phase * 0.6) * 0.35 + 1) / 2;
        const i = Math.max(0, Math.min(7, Math.round(y * 7)));
        const want = i >= 4 ? w.crest : w.trough;
        if (want !== tone) { out += want; tone = want; }
        out += w.blocks[i];
      }
      return out + w.off;
    }

    function draw() {
      const secs = Math.round((Date.now() - t0) / 1000);
      const msg = w.msgs[Atomics.load(s, PHASE)];
      const age = secs >= 3 ? w.dim + " " + secs + "s" + w.off : "";
      fs.writeSync(2, w.cr + "  " + w.anchor + " " + wave(frame++ * 0.35) + " " + w.dim + msg + w.ellipsis + w.off + age + w.clearEol);
    }

    // Atomics.wait doubles as the sleep: an exact 80ms tick that the main thread can cut
    // short the instant it needs the line back.
    Atomics.wait(s, STOP, 0, w.hold);
    if (!Atomics.load(s, STOP)) {
      fs.writeSync(2, w.hideCursor);
      Atomics.store(s, DREW, 1);
      while (!Atomics.load(s, STOP)) {
        draw();
        Atomics.wait(s, STOP, 0, 80);
      }
    }
    Atomics.store(s, ACK, 1);
    Atomics.notify(s, ACK);
    `,
    {
      eval: true,
      stdout: false,
      workerData: {
        sab,
        width,
        hold: HOLD_MS,
        blocks: BLOCKS,
        msgs: MSGS,
        ellipsis: ELLIPSIS,
        anchor: `\x1b[38;5;69m${ANCHOR}\x1b[0m`,
        crest: "\x1b[38;5;109m",
        trough: "\x1b[38;5;67m",
        dim: "\x1b[2m",
        off: "\x1b[0m",
        cr: "\r",
        clearEol: "\x1b[K",
        hideCursor: "\x1b[?25l",
      },
    },
  );
  worker.unref(); // never the reason this process stays alive
  worker.on("error", () => Atomics.store(state, STOP, 1)); // a splash is never worth a crash

  let running = true;
  let started = false; // seen TUI.start()
  let bytesAfterStart = 0;
  let appHidCursor = false; // Pi hid the cursor — leave it hidden on the way out

  // Park the drawing thread and WAIT for it to confirm, so the caller can write to the
  // terminal knowing nothing else will. Without the acknowledgement the worker could
  // land one last frame on top of Pi's first paint.
  function park() {
    Atomics.store(state, STOP, 1);
    Atomics.notify(state, STOP);
    if (!Atomics.load(state, ACK)) Atomics.wait(state, ACK, 0, 50);
  }

  // Our own control sequences, written straight to fd 2 and synchronously — see the note
  // at the top of the file for why process.stderr will not do. A short write or an EAGAIN
  // from a non-blocking tty is retried; anything else is swallowed, because a splash is
  // never worth a crash.
  function writeCtl(s) {
    const buf = Buffer.from(s, "utf8");
    for (let off = 0, tries = 0; off < buf.length && tries < 100; tries++) {
      try {
        off += fs.writeSync(2, buf, off);
      } catch (e) {
        if (e?.code !== "EAGAIN") return;
      }
    }
  }

  function clearLine() {
    if (Atomics.load(state, DREW)) writeCtl("\r\x1b[K");
  }

  function stop() {
    if (!running) return;
    running = false;
    park();
    clearLine();
    // Only give the cursor back if Pi hasn't deliberately hidden it — the TUI hides it
    // for the whole session and would never get the chance to hide it again.
    if (Atomics.load(state, DREW) && !appHidCursor) writeCtl("\x1b[?25h");
    process.stdout.write = outWrite;
    err.write = errWrite;
    worker.terminate();
  }

  // ── watch Pi's output ─────────────────────────────────────────────────────
  const size = (chunk) =>
    typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk?.length ?? 0;
  const text = (chunk) =>
    typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("latin1") : "";

  process.stdout.write = function (chunk, ...rest) {
    if (running) {
      const s = text(chunk);
      if (s.includes("\x1b[?25l")) appHidCursor = true;
      if (started) {
        bytesAfterStart += size(chunk);
        // Erase our line BEFORE the write lands, so Pi's output — a log line now, the
        // first frame in a moment — never has half a wave in front of it.
        if (bytesAfterStart >= FRAME_BYTES) stop();
        else clearLine();
      } else if (s.includes("\x1b[?2004h")) {
        started = true;
        Atomics.store(state, PHASE, 1);
        clearLine();
      } else {
        clearLine();
      }
    }
    return outWrite(chunk, ...rest);
  };

  // Pi's own warnings go to stderr, on the line we're animating.
  err.write = function (chunk, ...rest) {
    if (running) clearLine();
    return errWrite(chunk, ...rest);
  };

  process.on("exit", stop);

  // ── setRawMode EIO ────────────────────────────────────────────────────────
  // The other half of the long silent boot. Pi grabs raw mode ~19s in, and the tcsetattr
  // behind it returns EIO when the terminal is no longer ours to configure — an orphaned
  // process group (the shell that started us has exited), or a controlling terminal that
  // was revoked outright (window or tab closed, ssh dropped, session torn down). A boot
  // that spends half a minute unattended is exactly when that happens. Pi lets the error
  // out as an uncaught exception, so the user's reward for waiting is a native stack
  // trace ending in node:tty. Nothing can rescue the TUI — it has no way to read keys —
  // but it can say what happened in a sentence. (A merely BACKGROUNDED process is a
  // different case: it gets SIGTTOU and stops, and `fg` resumes it as normal.)
  const setRawMode = process.stdin.setRawMode?.bind(process.stdin);
  if (setRawMode) {
    process.stdin.setRawMode = function (mode) {
      try {
        return setRawMode(mode);
      } catch (e) {
        if (e?.code !== "EIO") throw e;
        stop();
        // writeCtl, not errWrite: process.exit() below does not flush a stream write that
        // Windows has merely queued, and this message is the only thing the user gets.
        writeCtl(
          [
            "",
            `  ${ANCHOR} Privateer couldn't take the helm — this terminal stopped accepting keyboard`,
            "     control while the agent was still loading (setRawMode EIO).",
            "",
            "     That usually means the window, tab or ssh session it started in went away.",
            `     Run \x1b[1m${process.env.PRIVATEER_CMD || "privateer"}\x1b[0m again from a terminal you're sitting in front of.`,
            "",
          ].join("\n") + "\n",
        );
        process.exit(1);
      }
    };
  }
}
