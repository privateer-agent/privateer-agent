import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Commits the agent makes carry a Co-authored-by trailer for github.com/privateer-first-mate
// (src/util/coauthor.ts), injected by rewriting the shell command in the tool_call hook.

process.env.PRIVATEER_HOME = mkdtempSync(join(tmpdir(), "privateer-coauthor-"));
const { withCoauthorTrailer, coauthorGitCommits, COAUTHOR_TRAILER } = await import("../src/util/coauthor.ts");

const FLAG = ` --trailer '${COAUTHOR_TRAILER}'`;

test("adds the trailer to a plain commit", () => {
  assert.equal(withCoauthorTrailer(`git commit -m "fix"`), `git commit${FLAG} -m "fix"`);
});

test("adds it to every commit in a chained command, after global options", () => {
  assert.equal(
    withCoauthorTrailer(`git add . && git -C "my repo" --no-pager commit -m x; git push`),
    `git add . && git -C "my repo" --no-pager commit${FLAG} -m x; git push`,
  );
  assert.equal(
    withCoauthorTrailer("cd app\ngit commit -am one && git commit --amend --no-edit"),
    `cd app\ngit commit${FLAG} -am one && git commit${FLAG} --amend --no-edit`,
  );
});

test("leaves quoted text, other subcommands and already-credited commands alone", () => {
  for (const cmd of [
    `git log --grep "git commit"`,
    `echo 'then git commit it'`,
    `git commit-tree HEAD^{tree}`,
    `git status`,
    `mygit commit -m x`,
    `git commit -m x${FLAG}`,
  ]) {
    assert.equal(withCoauthorTrailer(cmd), cmd);
  }
  // the message mentions a commit, but only the real command is rewritten
  assert.equal(
    withCoauthorTrailer(`git commit -m "; git commit"`),
    `git commit${FLAG} -m "; git commit"`,
  );
});

test("rewrites only shell tools, and honours the off switch", () => {
  const input = { command: "git commit -m x" };
  coauthorGitCommits("bash", input);
  assert.equal(input.command, `git commit${FLAG} -m x`);

  const write = { path: "a", content: "git commit -m x" };
  coauthorGitCommits("write", write);
  assert.equal(write.content, "git commit -m x");

  const off = { command: "git commit -m x" };
  coauthorGitCommits("bash", off, { PRIVATEER_COAUTHOR: "0" });
  assert.equal(off.command, "git commit -m x");
});

test("a real commit carries the trailer", () => {
  const repo = mkdtempSync(join(tmpdir(), "privateer-coauthor-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "user@example.com");
  git("config", "user.name", "User");
  const input = { command: `echo hi > a.txt && git add a.txt && git commit -q -m "first"` };
  coauthorGitCommits("bash", input);
  execSync(input.command, { cwd: repo, shell: "/bin/sh" });
  assert.equal(git("log", "-1", "--format=%B").trim(), `first\n\n${COAUTHOR_TRAILER}`);
});
