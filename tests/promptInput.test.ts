import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { PromptInput } from "../src/components/PromptInput.tsx";
import { COMMAND_LIST } from "../src/commands/registry.ts";
import {
  detectMode,
  slashQuery,
  isSlashCommand,
  mentionAt,
  filterCommands,
  filterFiles,
} from "../src/components/promptModel.ts";

const ESC = "";

// --- pure model ---------------------------------------------------------------

test("detectMode reads the leading character", () => {
  assert.equal(detectMode("!ls"), "bash");
  assert.equal(detectMode("#note"), "memory");
  assert.equal(detectMode("/model"), "command");
  assert.equal(detectMode("hello"), "prompt");
  assert.equal(detectMode(""), "prompt");
  // An absolute file path is a prompt (it gets attached), not a command.
  assert.equal(detectMode("/Users/me/shot.png"), "prompt");
});

test("isSlashCommand distinguishes commands from pasted file paths", () => {
  assert.equal(isSlashCommand("/"), true); // bare slash still opens the menu
  assert.equal(isSlashCommand("/model"), true);
  assert.equal(isSlashCommand("/model gpt-4"), true);
  assert.equal(isSlashCommand("/Users/me/Desktop/shot.png"), false); // path separators
  assert.equal(isSlashCommand("/My\\ Shot.png"), false); // has a dot/extension
  assert.equal(isSlashCommand("hello"), false);
});

test("slashQuery returns the command fragment, null once typing args", () => {
  assert.equal(slashQuery("/mod", 4), "mod");
  assert.equal(slashQuery("/", 1), "");
  assert.equal(slashQuery("/model gpt", 9), null); // past the name
  assert.equal(slashQuery("hello", 3), null);
});

test("mentionAt finds the @token and ignores mid-word @ (emails)", () => {
  assert.deepEqual(mentionAt("see @src/a", 10), { start: 4, query: "src/a" });
  assert.deepEqual(mentionAt("@", 1), { start: 0, query: "" });
  assert.equal(mentionAt("mail a@b.com", 12), null);
  assert.equal(mentionAt("no mention", 5), null);
});

test("filterCommands matches by name prefix", () => {
  const all = [
    { name: "model", summary: "" },
    { name: "mode", summary: "" },
    { name: "clear", summary: "" },
  ];
  assert.deepEqual(
    filterCommands(all, "mo").map((c) => c.name),
    ["model", "mode"],
  );
  assert.equal(filterCommands(all, "").length, 3);
});

test("filterFiles ranks basename hits first and respects the limit", () => {
  const files = ["src/util/auth.ts", "auth.test.ts", "docs/readme.md", "src/authenticate.ts"];
  const out = filterFiles(files, "auth", 2);
  assert.equal(out.length, 2);
  assert.ok(out.includes("auth.test.ts")); // basename match ranks high
});

// --- component interactions ---------------------------------------------------

// Poll until `pred` holds or the timeout elapses — avoids flakiness from fixed
// sleeps under concurrent test-runner load.
async function until(pred: () => boolean, timeout = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
}
const frameHas = (lastFrame: () => string | undefined, re: RegExp) => () => re.test(lastFrame() ?? "");

// Ink attaches its stdin listener in a mount effect, so the first keystrokes can
// be lost. Prime the input deterministically: write a throwaway char until it
// actually renders (proving the listener is live), then erase it.
async function focusInput(stdin: any, lastFrame: () => string | undefined): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    stdin.write("z");
    if (await until(frameHas(lastFrame, /❯ z/), 600)) {
      stdin.write(""); // backspace
      await until(() => !/z/.test(lastFrame() ?? ""), 600);
      return;
    }
  }
}

test("typing inserts text and a leading ! shows the bash tag", async () => {
  const history = { current: [] as string[] };
  const { stdin, lastFrame, unmount } = render(
    React.createElement(PromptInput, { busy: false, cwd: process.cwd(), queued: 0, commands: COMMAND_LIST, history, onSubmit: () => {} }),
  );
  await focusInput(stdin, lastFrame);
  stdin.write("!ls");
  assert.ok(await until(frameHas(lastFrame, /!ls/)), "buffer should show !ls");
  assert.match(lastFrame() ?? "", /\[bash\]/);
  unmount();
});

test("'/' opens the command autocomplete menu", async () => {
  const history = { current: [] as string[] };
  const { stdin, lastFrame, unmount } = render(
    React.createElement(PromptInput, { busy: false, cwd: process.cwd(), queued: 0, commands: COMMAND_LIST, history, onSubmit: () => {} }),
  );
  await focusInput(stdin, lastFrame);
  stdin.write("/m");
  assert.ok(await until(frameHas(lastFrame, /\/model/)), "menu should list /model");
  unmount();
});

test("'@' opens the file autocomplete menu from the cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-mention-"));
  writeFileSync(join(dir, "alpha.txt"), "hi", "utf8");
  try {
    const history = { current: [] as string[] };
    const { stdin, lastFrame, unmount } = render(
      React.createElement(PromptInput, { busy: false, cwd: dir, queued: 0, commands: COMMAND_LIST, history, onSubmit: () => {} }),
    );
    await focusInput(stdin, lastFrame);
    stdin.write("@al");
    assert.ok(await until(frameHas(lastFrame, /alpha\.txt/)), "menu should list alpha.txt");
    unmount();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Enter submits the buffer and clears it; up-arrow recalls history", async () => {
  const history = { current: [] as string[] };
  const calls: string[] = [];
  const { stdin, lastFrame, unmount } = render(
    React.createElement(PromptInput, {
      busy: false,
      cwd: process.cwd(),
      queued: 0,
      history,
      onSubmit: (v: string) => calls.push(v),
    }),
  );
  await focusInput(stdin, lastFrame);
  stdin.write("hi there");
  assert.ok(await until(frameHas(lastFrame, /hi there/)), "buffer should show typed text");
  stdin.write("\r"); // Enter
  assert.ok(await until(() => calls.length > 0), "onSubmit should fire");
  assert.deepEqual(calls, ["hi there"]);
  assert.equal(history.current.at(-1), "hi there");
  assert.ok(await until(frameHas(lastFrame, /type a prompt/)), "buffer should clear");
  stdin.write(`${ESC}[A`); // arrow up → recall
  assert.ok(await until(frameHas(lastFrame, /hi there/)), "history should recall");
  unmount();
});

test("dropping an image path converts it to an [Image #n] chip live and stages the attachment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-drop-"));
  try {
    const abs = join(dir, "Screenshot 2026-06-08 at 5.07.42 PM.png");
    // Full 8-byte PNG signature — a 4-byte truncation is a macOS promise stub and is
    // now rejected at capture, so it would never chip.
    writeFileSync(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const history = { current: [] as string[] };
    const imageSeqRef = { current: 0 };
    const pendingImagesRef = { current: [] as any[] };
    const { stdin, lastFrame, unmount } = render(
      React.createElement(PromptInput, {
        busy: false,
        cwd: dir,
        queued: 0,
        commands: COMMAND_LIST,
        history,
        imageSeqRef,
        pendingImagesRef,
        onSubmit: () => {},
      }),
    );
    await focusInput(stdin, lastFrame);
    // The form a macOS terminal drag-drop produces: backslash-escaped spaces + trailing space.
    stdin.write(abs.replace(/ /g, "\\ ") + " ");
    assert.ok(await until(frameHas(lastFrame, /\[Image #1\]/)), "buffer should show the chip");
    // The raw dropped path (temp dir + escaped spaces) must be gone from the buffer; the
    // basename alone is allowed to reappear in the staged-attachment provenance line below.
    const dirRe = new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    assert.doesNotMatch(lastFrame() ?? "", dirRe, "raw dropped path should be gone");
    assert.equal(pendingImagesRef.current.length, 1, "attachment staged");
    assert.equal(pendingImagesRef.current[0].n, 1);
    assert.equal(imageSeqRef.current, 1, "session counter advanced");
    unmount();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queued placeholder shows when busy", async () => {
  const history = { current: [] as string[] };
  const { lastFrame, unmount } = render(
    React.createElement(PromptInput, { busy: true, cwd: process.cwd(), queued: 2, commands: COMMAND_LIST, history, onSubmit: () => {} }),
  );
  assert.ok(await until(frameHas(lastFrame, /2 queued/)));
  unmount();
});

const CTRL_R = String.fromCharCode(18);

test("vim mode: Esc enters NORMAL, letters don't insert, i returns to INSERT", async () => {
  const history = { current: [] as string[] };
  const { stdin, lastFrame, unmount } = render(
    React.createElement(PromptInput, {
      busy: false,
      cwd: process.cwd(),
      queued: 0,
      vimEnabled: true,
      history,
      onSubmit: () => {},
    }),
  );
  await focusInput(stdin, lastFrame);
  stdin.write("abc");
  assert.ok(await until(frameHas(lastFrame, /abc/)), "typed text shows");
  assert.match(lastFrame() ?? "", /INSERT/);
  stdin.write(ESC);
  assert.ok(await until(frameHas(lastFrame, /NORMAL/)), "Esc enters normal mode");
  stdin.write("z"); // a normal-mode letter must not be inserted as text
  await new Promise((r) => setTimeout(r, 60));
  assert.doesNotMatch(lastFrame() ?? "", /abcz/);
  stdin.write("i");
  assert.ok(await until(frameHas(lastFrame, /INSERT/)), "i returns to insert mode");
  unmount();
});

test("ctrl-r reverse-searches history and Enter accepts the match", async () => {
  const history = { current: ["run tests", "build project"] };
  const { stdin, lastFrame, unmount } = render(
    React.createElement(PromptInput, { busy: false, cwd: process.cwd(), queued: 0, commands: COMMAND_LIST, history, onSubmit: () => {} }),
  );
  await focusInput(stdin, lastFrame);
  stdin.write(CTRL_R);
  assert.ok(await until(frameHas(lastFrame, /reverse-i-search/)), "search prompt shows");
  stdin.write("build");
  assert.ok(await until(frameHas(lastFrame, /build project/)), "match shown");
  stdin.write("\r"); // accept into buffer
  assert.ok(await until(() => !/reverse-i-search/.test(lastFrame() ?? "")), "search closes");
  assert.match(lastFrame() ?? "", /build project/);
  unmount();
});

// --- readline navigation / editing shortcuts ---------------------------------

// Control codes. Alt+<letter> is ESC followed by the letter.
const CTRL_A = "\x01";
const CTRL_B = "\x02";
const CTRL_D = "\x04";
const CTRL_F = "\x06";
const CTRL_K = "\x0b";
const CTRL_U = "\x15";
const CTRL_Y = "\x19";
const CTRL_LEFT = `${ESC}[1;5D`;
const CTRL_RIGHT = `${ESC}[1;5C`;
const ALT_LEFT = `${ESC}[1;3D`;
const ALT_RIGHT = `${ESC}[1;3C`;

// Drive a fresh input, type `keys`, submit, and return the value passed to
// onSubmit. The block cursor splits the rendered frame with ANSI codes, so we
// assert on the submitted buffer rather than scraping the frame.
async function typeAndSubmit(keys: string[]): Promise<string | undefined> {
  const history = { current: [] as string[] };
  const calls: string[] = [];
  const { stdin, lastFrame, unmount } = render(
    React.createElement(PromptInput, {
      busy: false,
      cwd: process.cwd(),
      queued: 0,
      commands: COMMAND_LIST,
      history,
      onSubmit: (v: string) => calls.push(v),
    }),
  );
  try {
    await focusInput(stdin, lastFrame);
    for (const k of keys) stdin.write(k);
    stdin.write("\r");
    await until(() => calls.length > 0);
    return calls[0];
  } finally {
    unmount();
  }
}

test("Ctrl+A + Alt+F + Ctrl+K: jump to start, word-forward, kill to end", async () => {
  // "hello world" → Ctrl+A (start) → Alt+F (end of "hello") → Ctrl+K (kill " world")
  assert.equal(await typeAndSubmit(["hello world", CTRL_A, `${ESC}f`, CTRL_K]), "hello");
});

test("Ctrl+U kills to start and Ctrl+Y yanks it back", async () => {
  // "world" → Ctrl+U (kill to "") → Ctrl+Y (paste "world" back)
  assert.equal(await typeAndSubmit(["world", CTRL_U, CTRL_Y]), "world");
});

test("Ctrl+D forward-deletes the char under the cursor", async () => {
  // "abc" → Ctrl+A (start) → Ctrl+D (delete 'a')
  assert.equal(await typeAndSubmit(["abc", CTRL_A, CTRL_D]), "bc");
});

test("Ctrl+D is a no-op at end of buffer", async () => {
  assert.equal(await typeAndSubmit(["abc", CTRL_D]), "abc");
});

test("Ctrl+B and Ctrl+F move by one character", async () => {
  // "ab" → Ctrl+A (start) → Ctrl+F (between a,b) → type X → "aXb"
  assert.equal(await typeAndSubmit(["ab", CTRL_A, CTRL_F, "X"]), "aXb");
  // "ac" → Ctrl+B (before c) → type b → "abc"
  assert.equal(await typeAndSubmit(["ac", CTRL_B, "b"]), "abc");
});

test("Alt+B jumps back one word", async () => {
  // "foo bar" → Alt+B (start of "bar") → type X → "foo Xbar"
  assert.equal(await typeAndSubmit(["foo bar", `${ESC}b`, "X"]), "foo Xbar");
});

test("Alt+D kills the next word (readline: leaves leading space)", async () => {
  // "foo bar" → Ctrl+A (start) → Alt+D (kill "foo", leaving " bar")
  assert.equal(await typeAndSubmit(["foo bar", CTRL_A, `${ESC}d`]), " bar");
});

const ALT_BACKSPACE = `${ESC}\x7f`;

test("Alt/Option+Backspace deletes the word before the cursor", async () => {
  // "foo bar" → Option+Delete kills "bar", leaving "foo "
  assert.equal(await typeAndSubmit(["foo bar", ALT_BACKSPACE]), "foo ");
  // killed word is yankable via Ctrl+Y
  assert.equal(await typeAndSubmit(["foo bar", ALT_BACKSPACE, CTRL_Y]), "foo bar");
});

test("Ctrl+Left/Right jump by word", async () => {
  // "foo bar" → Ctrl+Left (start of "bar") → type X
  assert.equal(await typeAndSubmit(["foo bar", CTRL_LEFT, "X"]), "foo Xbar");
  // "foo bar" → Ctrl+A → Ctrl+Right (end of "foo") → type X
  assert.equal(await typeAndSubmit(["foo bar", CTRL_A, CTRL_RIGHT, "X"]), "fooX bar");
});

test("Alt+Left/Right jump by word", async () => {
  assert.equal(await typeAndSubmit(["foo bar", ALT_LEFT, "X"]), "foo Xbar");
  assert.equal(await typeAndSubmit(["foo bar", CTRL_A, ALT_RIGHT, "X"]), "fooX bar");
});
