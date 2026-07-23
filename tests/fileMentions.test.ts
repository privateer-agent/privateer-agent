import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMentions,
  resolveMentions,
  searchFiles,
  completeMention,
} from "../src/util/fileMentions.ts";

// A throwaway project tree under the OS temp dir.
function scratch(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "pv-mentions-"));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

// A tiny valid PNG (1x1) so image detection has real bytes.
const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c626001000000 ffff03000006000557bfabd40000000049454e44ae426082".replace(/\s/g, ""),
  "hex",
);

test("parseMentions extracts bare, quoted, and mid-line tokens (de-duped)", () => {
  assert.deepEqual(parseMentions("look at @src/a.ts and @src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(parseMentions('open @"my file.txt" please'), ["my file.txt"]);
  assert.deepEqual(parseMentions("no mentions here"), []);
  assert.deepEqual(parseMentions("email me@example.com is not a mention"), []); // @ mid-word
});

test("resolveMentions appends a <file> block for a text file and keeps the token inline", async () => {
  const { cwd, cleanup } = scratch();
  try {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "a.ts"), "export const x = 1;\n");
    const r = await resolveMentions("explain @src/a.ts", cwd);
    assert.match(r.text, /^explain @src\/a\.ts/); // mention stays inline
    assert.match(r.text, /<file name="src\/a\.ts">\nexport const x = 1;\n\n<\/file>/);
    assert.deepEqual(r.resolved, ["src/a.ts"]);
    assert.deepEqual(r.skipped, []);
    assert.equal(r.images.length, 0);
  } finally {
    cleanup();
  }
});

test("resolveMentions returns an image attachment for an image mention", async () => {
  const { cwd, cleanup } = scratch();
  try {
    writeFileSync(join(cwd, "logo.png"), PNG_1PX);
    const r = await resolveMentions("what is @logo.png", cwd);
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0].mimeType, "image/png");
    assert.ok(r.images[0].data.length > 0);
    assert.match(r.text, /<file name="logo\.png"><\/file>/);
    assert.deepEqual(r.resolved, ["logo.png"]);
  } finally {
    cleanup();
  }
});

test("resolveMentions leaves the text unchanged when nothing resolves", async () => {
  const { cwd, cleanup } = scratch();
  try {
    const r = await resolveMentions("reference @does/not/exist here", cwd);
    assert.equal(r.text, "reference @does/not/exist here");
    assert.deepEqual(r.skipped, ["does/not/exist"]);
  } finally {
    cleanup();
  }
});

test("resolveMentions REFUSES paths that escape cwd (absolute + ..)", async () => {
  const { cwd, cleanup } = scratch();
  try {
    // A real file outside cwd.
    const outside = scratch();
    writeFileSync(join(outside.cwd, "secret.txt"), "TOPSECRET");
    try {
      const abs = await resolveMentions(`read @${join(outside.cwd, "secret.txt")}`, cwd);
      assert.ok(!abs.text.includes("TOPSECRET"), "absolute path outside cwd must not be read");
      const up = await resolveMentions("read @../../etc/hosts", cwd);
      assert.ok(!up.text.includes("<file"), "`..` escape must not be read");
      assert.deepEqual(up.images, []);
    } finally {
      outside.cleanup();
    }
  } finally {
    cleanup();
  }
});

test("resolveMentions refuses a symlink that points outside cwd", async () => {
  const { cwd, cleanup } = scratch();
  const outside = scratch();
  try {
    writeFileSync(join(outside.cwd, "secret.txt"), "TOPSECRET");
    symlinkSync(join(outside.cwd, "secret.txt"), join(cwd, "link.txt"));
    const r = await resolveMentions("read @link.txt", cwd);
    assert.ok(!r.text.includes("TOPSECRET"), "symlink out of cwd must not be followed");
    assert.deepEqual(r.resolved, []);
  } finally {
    cleanup();
    outside.cleanup();
  }
});

test("searchFiles prefix-matches within cwd, dirs first, ignoring noise", async () => {
  const { cwd, cleanup } = scratch();
  try {
    mkdirSync(join(cwd, "src"));
    mkdirSync(join(cwd, "node_modules"));
    writeFileSync(join(cwd, "server.ts"), "");
    writeFileSync(join(cwd, "README.md"), "");
    const all = await searchFiles("s", cwd);
    const paths = all.map((m) => m.path);
    assert.deepEqual(paths, ["src/", "server.ts"]); // dir before file, both start with s
    assert.ok(!paths.includes("node_modules/"), "node_modules is filtered");
    // Drill into a directory with a trailing slash.
    writeFileSync(join(cwd, "src", "index.ts"), "");
    const inSrc = await searchFiles("src/", cwd);
    assert.deepEqual(inSrc.map((m) => m.path), ["src/index.ts"]);
  } finally {
    cleanup();
  }
});

test("searchFiles refuses to escape cwd", async () => {
  const { cwd, cleanup } = scratch();
  try {
    assert.deepEqual(await searchFiles("../", cwd), []);
    assert.deepEqual(await searchFiles("/etc/", cwd), []);
  } finally {
    cleanup();
  }
});

test("completeMention returns full-line completions for a trailing @token", async () => {
  const { cwd, cleanup } = scratch();
  try {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "app.ts"), "");
    const [hits, line] = await completeMention("explain @src/a", cwd);
    assert.equal(line, "explain @src/a");
    assert.deepEqual(hits, ["explain @src/app.ts"]);
    // Not in a mention → no completions, line untouched.
    assert.deepEqual(await completeMention("just text", cwd), [[], "just text"]);
  } finally {
    cleanup();
  }
});
