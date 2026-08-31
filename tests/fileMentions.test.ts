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

test("searchFiles reaches files in any subdirectory by a name fragment (project-wide)", async () => {
  const { cwd, cleanup } = scratch();
  try {
    mkdirSync(join(cwd, "screens", "deep"), { recursive: true });
    writeFileSync(join(cwd, "screens", "deep", "RemoteSessionScreen.tsx"), "");
    writeFileSync(join(cwd, "screens", "deep", "remoteNotes.md"), "");
    const hits = await searchFiles("remo", cwd);
    assert.ok(hits.some((m) => m.path === "screens/deep/RemoteSessionScreen.tsx"), "fragment must reach nested files");
    assert.ok(hits.some((m) => m.path === "screens/deep/remoteNotes.md"));
    // A name that STARTS with the fragment outranks a deeper one that merely
    // carries it ("sessions.md" starts with "sess"; the screen file only contains it).
    mkdirSync(join(cwd, "screens", "deep", "notes"));
    writeFileSync(join(cwd, "screens", "deep", "notes", "sessions.md"), "");
    const sess = await searchFiles("sess", cwd);
    assert.equal(sess[0].path, "screens/deep/notes/sessions.md");
    assert.ok(sess.some((m) => m.path === "screens/deep/RemoteSessionScreen.tsx"));
    // Case-insensitive.
    assert.ok((await searchFiles("REMO", cwd)).some((m) => m.path === "screens/deep/RemoteSessionScreen.tsx"));
  } finally {
    cleanup();
  }
});

test("searchFiles dir-qualified fragment matches whole paths (and its own dir first)", async () => {
  const { cwd, cleanup } = scratch();
  try {
    mkdirSync(join(cwd, "src", "util"), { recursive: true });
    writeFileSync(join(cwd, "src", "util", "cache.ts"), "");
    const hits = await searchFiles("src/ut", cwd);
    assert.equal(hits[0].path, "src/util/", "the exact drill-down child ranks first");
    assert.ok(hits.some((m) => m.path === "src/util/cache.ts"), "the path match is included");
    // Even a one-char basename works when the query is dir-qualified — the whole-path
    // match is precise, unlike a bare single-char fragment ("src/u" ⊂ "src/util/...").
    assert.ok((await searchFiles("src/u", cwd)).some((m) => m.path === "src/util/cache.ts"));
  } finally {
    cleanup();
  }
});

test("searchFiles one-char bare fragment stays drill-down only (no whole-tree noise)", async () => {
  const { cwd, cleanup } = scratch();
  try {
    mkdirSync(join(cwd, "screens"));
    writeFileSync(join(cwd, "screens", "a.tsx"), "");
    // No root child starts with "a", and a whole-tree sweep for one character would
    // be all noise — so nothing, rather than every file containing an "a".
    assert.deepEqual(await searchFiles("a", cwd), []);
  } finally {
    cleanup();
  }
});

test("searchFiles walk prunes node_modules and .git, and never follows symlinked dirs", async () => {
  const { cwd, cleanup } = scratch();
  const outside = scratch();
  try {
    mkdirSync(join(cwd, "node_modules", "left-pad"), { recursive: true });
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, "real"));
    writeFileSync(join(cwd, "node_modules", "left-pad", "index.js"), "");
    writeFileSync(join(outside.cwd, "leak.ts"), "SECRET");
    symlinkSync(outside.cwd, join(cwd, "real", "out"));
    // Only ignored entries carry "index"; the leak only sits behind a symlinked dir.
    assert.deepEqual(await searchFiles("index", cwd), []);
    assert.deepEqual(await searchFiles("leak", cwd), []);
  } finally {
    cleanup();
    outside.cleanup();
  }
});

test("searchFiles walk honors .gitignore (root, nested, and globs)", async () => {
  const { cwd, cleanup } = scratch();
  try {
    mkdirSync(join(cwd, "pods", "Stripe"), { recursive: true });
    mkdirSync(join(cwd, "src", "vendor"), { recursive: true });
    writeFileSync(join(cwd, "pods", "Stripe", "Huge.swift"), "");
    writeFileSync(join(cwd, "src", "vendor", "gen.ts"), "");
    writeFileSync(join(cwd, "src", "app.ts"), "");
    // Root ignore: any dir named pods/ anywhere (this is what keeps a vendor tree
    // from eating the walk's budget before real source is reached).
    writeFileSync(join(cwd, ".gitignore"), "# deps\npods/\n");
    // Nested ignore: scoped to its own dir only.
    writeFileSync(join(cwd, "src", ".gitignore"), "vendor/\n");
    assert.deepEqual(await searchFiles("huge", cwd), [], "gitignored tree is pruned from the sweep");
    assert.deepEqual(await searchFiles("gen", cwd), [], "nested gitignore scopes to its dir");
    assert.deepEqual(await searchFiles("app.ts", cwd), [{ path: "src/app.ts", isDir: false }]);
    // Glob forms still prune: an anchored path and a single-segment wildcard.
    writeFileSync(join(cwd, "src", "secrets.key"), "");
    writeFileSync(join(cwd, ".gitignore"), "pods/\n*.key\n");
    assert.deepEqual(await searchFiles("secrets", cwd), []);
    // Tier-1 drill-down is NOT gitignore-filtered: naming a dir lists it, exactly.
    assert.deepEqual((await searchFiles("pods/", cwd)).map((m) => m.path), ["pods/Stripe/"]);
  } finally {
    cleanup();
  }
});

test("searchFiles bare @ browses the whole tree, shallow-first", async () => {
  const { cwd, cleanup } = scratch();
  try {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "a.ts"), "");
    writeFileSync(join(cwd, "src", "deep.ts"), "");
    const paths = (await searchFiles("", cwd)).map((m) => m.path);
    assert.ok(paths.includes("src/deep.ts"), "a bare @ reaches subdirectory files");
    assert.ok(paths.indexOf("a.ts") < paths.indexOf("src/deep.ts"), "root entries come before depth-2 ones");
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
