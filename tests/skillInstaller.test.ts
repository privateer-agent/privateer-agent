import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSkillSource,
  discoverSkills,
  installFromDir,
  removeSkill,
} from "../src/skills/installer.ts";
import { loadSkills } from "../src/skills/loader.ts";

// --- parseSkillSource ----------------------------------------------------------

test("parseSkillSource accepts the supported forms", () => {
  assert.deepEqual(parseSkillSource("anthropics/skills"), {
    repoUrl: "https://github.com/anthropics/skills.git",
    ref: undefined,
    subpath: undefined,
  });
  assert.deepEqual(parseSkillSource("anthropics/skills/document-skills/pdf"), {
    repoUrl: "https://github.com/anthropics/skills.git",
    ref: undefined,
    subpath: "document-skills/pdf",
  });
  assert.deepEqual(parseSkillSource("https://github.com/anthropics/skills"), {
    repoUrl: "https://github.com/anthropics/skills.git",
    ref: undefined,
    subpath: undefined,
  });
  assert.deepEqual(parseSkillSource("https://github.com/anthropics/skills.git"), {
    repoUrl: "https://github.com/anthropics/skills.git",
    ref: undefined,
    subpath: undefined,
  });
  assert.deepEqual(parseSkillSource("https://github.com/anthropics/skills/tree/main/document-skills/pdf"), {
    repoUrl: "https://github.com/anthropics/skills.git",
    ref: "main",
    subpath: "document-skills/pdf",
  });
});

test("parseSkillSource rejects bad inputs", () => {
  assert.throws(() => parseSkillSource("justoneword"));
  assert.throws(() => parseSkillSource("https://gitlab.com/a/b"));
  assert.throws(() => parseSkillSource("a/b/../escape"));
  assert.throws(() => parseSkillSource("git@github.com:a/b.git"));
});

// --- fixtures --------------------------------------------------------------------

function makeSkillFixture(root: string, rel: string, name: string, opts?: { invalid?: boolean }) {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  const fm = opts?.invalid ? `name: ${name}` : `name: ${name}\ndescription: does ${name} things`;
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\nInstructions for ${name}.\n`, "utf8");
  return dir;
}

// --- discoverSkills ----------------------------------------------------------------

test("discoverSkills finds a single skill at a subpath and scans for many", () => {
  const repo = mkdtempSync(join(tmpdir(), "priv-repo-"));
  try {
    makeSkillFixture(repo, "skills/alpha", "alpha");
    makeSkillFixture(repo, "skills/nested/beta", "beta");
    makeSkillFixture(repo, "skills/broken", "broken", { invalid: true });

    const single = discoverSkills(repo, "skills/alpha");
    assert.equal(single.found.length, 1);
    assert.equal(single.found[0].name, "alpha");

    const all = discoverSkills(repo);
    assert.deepEqual(all.found.map((f) => f.name).sort(), ["alpha", "beta"]);
    assert.deepEqual(all.invalid, ["broken"]);

    assert.throws(() => discoverSkills(repo, "does/not/exist"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- installFromDir ------------------------------------------------------------------

function withHome(fn: (home: string, proj: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const proj = mkdtempSync(join(tmpdir(), "priv-proj-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    fn(home, proj);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
}

test("installFromDir installs a single skill into the chosen scope", () => {
  withHome((home, proj) => {
    const repo = mkdtempSync(join(tmpdir(), "priv-repo-"));
    try {
      const src = makeSkillFixture(repo, "skills/alpha", "alpha");
      writeFileSync(join(src, "notes.md"), "extra file", "utf8");

      const user = installFromDir(repo, undefined, { scope: "user", cwd: proj });
      assert.equal(user[0].name, "alpha");
      assert.ok(existsSync(join(home, "skills", "alpha", "SKILL.md")));
      assert.ok(existsSync(join(home, "skills", "alpha", "notes.md")));

      const project = installFromDir(repo, undefined, { scope: "project", cwd: proj });
      assert.ok(existsSync(join(proj, ".privateer", "skills", "alpha", "SKILL.md")));
      assert.equal(project[0].name, "alpha");
      // Installed skills are visible to the loader.
      assert.ok(loadSkills(proj).skills.some((s) => s.name === "alpha" && s.scope === "project"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("installFromDir requires --all for multi-skill repos and honors collisions", () => {
  withHome((home, proj) => {
    const repo = mkdtempSync(join(tmpdir(), "priv-repo-"));
    try {
      makeSkillFixture(repo, "skills/alpha", "alpha");
      makeSkillFixture(repo, "skills/beta", "beta");

      assert.throws(() => installFromDir(repo, undefined, { scope: "user", cwd: proj }), /--all/);

      const both = installFromDir(repo, undefined, { scope: "user", all: true, cwd: proj });
      assert.equal(both.length, 2);

      // Collision without --force fails; with --force replaces.
      assert.throws(() => installFromDir(repo, "skills/alpha", { scope: "user", cwd: proj }), /--force/);
      const forced = installFromDir(repo, "skills/alpha", { scope: "user", force: true, cwd: proj });
      assert.equal(forced[0].name, "alpha");
      assert.ok(existsSync(join(home, "skills", "alpha", "SKILL.md")));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("installFromDir skips symlinks and rejects an all-invalid source", () => {
  withHome((home, proj) => {
    const repo = mkdtempSync(join(tmpdir(), "priv-repo-"));
    try {
      const src = makeSkillFixture(repo, "skills/alpha", "alpha");
      writeFileSync(join(repo, "outside.txt"), "outside", "utf8");
      symlinkSync(join(repo, "outside.txt"), join(src, "link.txt"));

      installFromDir(repo, "skills/alpha", { scope: "user", cwd: proj });
      assert.ok(!existsSync(join(home, "skills", "alpha", "link.txt")), "symlink not copied");

      makeSkillFixture(repo, "skills/broken", "broken", { invalid: true });
      assert.throws(() => installFromDir(repo, "skills/broken", { scope: "user", cwd: proj }), /No installable skills/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// --- removeSkill -----------------------------------------------------------------------

test("removeSkill removes by scope precedence and validates existence", () => {
  withHome((home, proj) => {
    const repo = mkdtempSync(join(tmpdir(), "priv-repo-"));
    try {
      makeSkillFixture(repo, "skills/alpha", "alpha");
      installFromDir(repo, undefined, { scope: "user", cwd: proj });
      installFromDir(repo, undefined, { scope: "project", cwd: proj });

      // Default removes the project copy first (lookup precedence).
      const first = removeSkill("alpha", { cwd: proj });
      assert.ok(first.dir.startsWith(join(proj, ".privateer")));
      assert.ok(!existsSync(join(proj, ".privateer", "skills", "alpha")));
      assert.ok(existsSync(join(home, "skills", "alpha")));

      const second = removeSkill("alpha", { cwd: proj });
      assert.ok(second.dir.startsWith(home));
      assert.throws(() => removeSkill("alpha", { cwd: proj }), /No installed skill/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
