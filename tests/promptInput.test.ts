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
