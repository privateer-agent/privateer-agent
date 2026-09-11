import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dirname, "..", "bin");
const LAUNCHER = join(BIN, "privateer-launch.mjs");

test("init: scaffolds PRIVATEER.md in the target directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "privateer-init-test-"));
  try {
    const res = spawnSync(process.execPath, [LAUNCHER, "init", dir], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `Command failed: ${res.stderr}`);
    assert.match(res.stdout, /Created .*PRIVATEER\.md/);
    const target = join(dir, "PRIVATEER.md");
    assert.ok(existsSync(target), "PRIVATEER.md must exist");
    const content = readFileSync(target, "utf8");
    assert.match(content, /# PRIVATEER\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: scaffolds PRIVATEER.md in current directory when omitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "privateer-init-test-"));
  try {
    const res = spawnSync(process.execPath, [LAUNCHER, "init"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `Command failed: ${res.stderr}`);
    assert.match(res.stdout, /Created .*PRIVATEER\.md/);
    assert.ok(existsSync(join(dir, "PRIVATEER.md")), "PRIVATEER.md must exist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: does not overwrite if PRIVATEER.md already exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "privateer-init-test-"));
  try {
    const target = join(dir, "PRIVATEER.md");
    writeFileSync(target, "Existing content");
    const res = spawnSync(process.execPath, [LAUNCHER, "init", dir], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /already exists/);
    assert.equal(readFileSync(target, "utf8"), "Existing content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: errors on invalid options or extra arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "privateer-init-test-"));
  try {
    const resOpt = spawnSync(process.execPath, [LAUNCHER, "init", "--foo"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(resOpt.status, 1);
    assert.match(resOpt.stderr, /unknown option '--foo'/i);

    const resExtra = spawnSync(process.execPath, [LAUNCHER, "init", "dir1", "dir2"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(resExtra.status, 1);
    assert.match(resExtra.stderr, /unexpected argument 'dir2'/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init: supports --help and -h flags", () => {
  const res = spawnSync(process.execPath, [LAUNCHER, "init", "--help"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage: privateer init/);
});

test("help: top-level and subcommand help works cleanly", () => {
  const helpTop = spawnSync(process.execPath, [LAUNCHER, "--help"], {
    encoding: "utf8",
  });
  assert.equal(helpTop.status, 0);
  assert.match(helpTop.stdout, /privateer init/);
  assert.match(helpTop.stdout, /privateer update/);

  const helpSub = spawnSync(process.execPath, [LAUNCHER, "help", "init"], {
    encoding: "utf8",
  });
  assert.equal(helpSub.status, 0);
  assert.match(helpSub.stdout, /Usage: privateer init/);

  const helpUpdate = spawnSync(process.execPath, [LAUNCHER, "help", "update"], {
    encoding: "utf8",
  });
  assert.equal(helpUpdate.status, 0);
  assert.match(helpUpdate.stdout, /privateer update — fetch the latest release/);
});

test("splash: launcher suppresses splash on non-interactive flags and subcommands", () => {
  const launcherSrc = readFileSync(LAUNCHER, "utf8");
  assert.match(
    launcherSrc,
    /isNonInteractive/,
    "launcher must identify non-interactive commands/flags before loading splash",
  );
  assert.match(
    launcherSrc,
    /if\s*\(!isNonInteractive\s*&&\s*fs\.existsSync\(splash\)\)\s*nodeArgs\.push\("--import"/,
    "splash must only be loaded when interactive",
  );
});
