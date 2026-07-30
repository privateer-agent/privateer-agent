import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { classifyToolCall } from "../src/permissions/classify.ts";

// The gate decides whether an action is in scope; Pi's tools decide where the write
// actually lands. If those two resolve a path string differently, the gate is judging
// a file nobody touches while the tool touches one nobody judged.
//
// That gap was real: `node:path` treats "~/x", "@/x" and "file:///x" as RELATIVE, so
// the classifier placed them inside the working directory while Pi's resolver expanded
// them to $HOME, /, and / respectively. `outside` came back false, `protected` came
// back false (isProtectedPath matches basenames, and "authorized_keys" is not one),
// which meant reads were UNGATED in every posture — including readonly, at the default
// read-only tool ceiling — and writes auto-allowed under acceptEdits / no-quarter.
//
// These tests pin the two resolvers together. The parity test imports Pi's own
// resolver, so a Pi upgrade that changes normalization fails here instead of quietly
// reopening the hole.

// Pi's own resolver. The package `exports` map allows only "." and "./rpc-entry", and
// neither re-exports this — which is exactly why classify.ts has to mirror the logic
// rather than import it. A file:// URL sidesteps package-exports resolution, which is
// acceptable in a test whose entire purpose is to compare against the real thing.
const PI_PATH_UTILS = new URL(
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js",
  import.meta.url,
).href;
const { resolveToCwd } = (await import(PI_PATH_UTILS)) as {
  resolveToCwd: (filePath: string, cwd: string) => string;
};

// The classifier deliberately canonicalizes symlinks (realBase / P5-1) so an in-cwd
// symlink can't smuggle a target out of scope; Pi's resolver does not. On macOS that
// alone makes them differ (/etc → /private/etc, /var → /private/var), so parity is
// asserted MODULO that canonicalization — which only ever tightens scope, never widens
// it. This mirrors realBase: realpath the deepest existing ancestor, re-append the tail.
function canonical(abs: string): string {
  let dir = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(dir);
      return tail.length ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return abs;
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
}

function withCwd(fn: (cwd: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "priv-scope-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every shape that normalizes differently from bare node:path, plus controls.
const CORPUS = [
  "~/.ssh/authorized_keys",
  "~/Library/LaunchAgents/evil.plist",
  "~",
  "@/etc/cron.d/x",
  "@~/.ssh/authorized_keys",
  "@relative/inside.ts",
  "file:///etc/passwd",
  // controls — these already agreed
  "src/app.ts",
  "./nested/file.ts",
  "../../etc/passwd",
  "/etc/passwd",
];

test("classifier resolves every path exactly as Pi's tools do", () => {
  withCwd((cwd) => {
    for (const p of CORPUS) {
      const req = classifyToolCall("write", { path: p }, { cwd, confineToCwd: true });
      assert.ok(req, `expected a gate request for ${p}`);
      assert.equal(
        req.path,
        canonical(resolveToCwd(p, cwd)),
        `classifier and Pi disagree on "${p}" — the gate would judge a different file than the tool writes`,
      );
    }
  });
});

test("tilde, @ and file:// targets are recognized as OUTSIDE the working directory", () => {
  withCwd((cwd) => {
    for (const p of ["~/.ssh/authorized_keys", "@/etc/cron.d/x", "@~/.ssh/authorized_keys", "file:///etc/passwd"]) {
      const req = classifyToolCall("write", { path: p }, { cwd, confineToCwd: true });
      assert.equal(req?.outside, true, `${p} must be flagged outside — it resolves out of cwd`);
    }
  });
});

test("tilde and @ READS are gated rather than running silently", () => {
  // The worst half of the bug: reads inside scope return null (no gate at all), so an
  // unexpanded "~" made secret files ungated in EVERY posture, including readonly.
  withCwd((cwd) => {
    for (const p of ["~/.ssh/id_ed25519", "@/etc/shadow", "~/.aws/credentials"]) {
      const req = classifyToolCall("read", { path: p }, { cwd, confineToCwd: true });
      assert.ok(req, `${p} must be gated, not silently allowed`);
      assert.equal(req.outside, true);
    }
  });
});

test("ordinary in-cwd work still needs no gate", () => {
  // The fix must not add friction to the common case.
  withCwd((cwd) => {
    assert.equal(classifyToolCall("read", { path: "src/app.ts" }, { cwd, confineToCwd: true }), null);
    assert.equal(classifyToolCall("read", { path: "./a/b.ts" }, { cwd, confineToCwd: true }), null);
    const write = classifyToolCall("write", { path: "src/app.ts" }, { cwd, confineToCwd: true });
    assert.equal(write?.outside, false);
    assert.equal(write?.path, canonical(resolve(cwd, "src/app.ts")));
  });
});

test("a literal '~' resolves to the home directory, not a directory named ~", () => {
  withCwd((cwd) => {
    const req = classifyToolCall("write", { path: "~" }, { cwd, confineToCwd: true });
    assert.equal(req?.path, homedir());
    assert.equal(req?.outside, true);
  });
});

test("unicode spaces are folded the same way Pi folds them", () => {
  // Pi replaces NBSP and friends with a plain space before resolving; a classifier
  // that didn't would compute a sibling path that no tool ever touches.
  withCwd((cwd) => {
    const p = "src/my file.ts";
    const req = classifyToolCall("write", { path: p }, { cwd, confineToCwd: true });
    assert.equal(req?.path, canonical(resolveToCwd(p, cwd)));
    assert.ok(!req!.path!.includes(" "), "NBSP should have been folded to a plain space");
  });
});

test("a malformed file:// URL does not throw out of the gate", () => {
  // Pi lets fileURLToPath throw (failing the tool call). The gate must never throw —
  // an exception there would be a denial-of-gate, not a denial of the action.
  withCwd((cwd) => {
    assert.doesNotThrow(() => classifyToolCall("write", { path: "file://" }, { cwd, confineToCwd: true }));
    assert.doesNotThrow(() => classifyToolCall("read", { path: "file://h ost/x" }, { cwd, confineToCwd: true }));
  });
});
