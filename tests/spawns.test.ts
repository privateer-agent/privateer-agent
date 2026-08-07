// PRIVATEER_HOME must point somewhere disposable before the module resolves paths
// (globalDir reads it lazily, so setting it here is enough).
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-spawns-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetSpawn,
  listSpawns,
  readSpawn,
  spawnDir,
  spawnKey,
  spawnSkillsDir,
  spawnsDir,
  touchSpawn,
  writeSpawn,
} from "../src/config/spawns.ts";

function freshHome(): void {
  rmSync(process.env.PRIVATEER_HOME!, { recursive: true, force: true });
  mkdirSync(process.env.PRIVATEER_HOME!, { recursive: true });
}

/** A real directory on disk — spawn keys resolve symlinks, so these must exist. */
function folder(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), "pv-spawn-")), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("writeSpawn creates a record; readSpawn returns it", () => {
  freshHome();
  const dir = folder("alpha");

  assert.equal(readSpawn(dir), null, "no record before one is written");

  const rec = writeSpawn(dir, { model: "privateer/tinfoil/glm-5-2", connectors: ["github"] }, 1000);
  assert.equal(rec.model, "privateer/tinfoil/glm-5-2");
  assert.deepEqual(rec.connectors, ["github"]);
  assert.equal(rec.createdAt, 1000);
  assert.equal(rec.lastOpenedAt, null, "writing defaults is not opening");

  assert.deepEqual(readSpawn(dir), rec);
});

test("a patch keeps fields it does not mention", () => {
  freshHome();
  const dir = folder("beta");
  writeSpawn(dir, { model: "a/b", connectors: ["github", "linear"] }, 1000);

  // The window that knows the new model does not know the connectors, and must not
  // clobber them — this is the concurrent-window case, not a hypothetical.
  const after = writeSpawn(dir, { model: "c/d" }, 2000);
  assert.equal(after.model, "c/d");
  assert.deepEqual(after.connectors, ["github", "linear"], "untouched fields survive");
  assert.equal(after.createdAt, 1000, "createdAt is set once");
});

test("touchSpawn stamps lastOpenedAt and drives list order", () => {
  freshHome();
  const a = folder("a");
  const b = folder("b");
  const c = folder("c");
  writeSpawn(a, { model: "m/1" }, 10);
  writeSpawn(b, { model: "m/2" }, 20);
  writeSpawn(c, { model: "m/3" }, 30);

  touchSpawn(b, 500);
  touchSpawn(a, 900);

  const listed = listSpawns().map((r) => r.path);
  assert.equal(listed.length, 3);
  assert.equal(listed[0], a, "most recently opened first");
  assert.equal(listed[1], b);
  assert.equal(listed[2], c, "never-opened last");
});

test("the record is keyed by REAL path, so a symlinked route shares it", () => {
  freshHome();
  const real = folder("checkout");
  const link = join(mkdtempSync(join(tmpdir(), "pv-spawn-link-")), "via-link");
  symlinkSync(real, link, "dir");

  writeSpawn(real, { model: "real/model" }, 1000);

  assert.equal(spawnKey(link), spawnKey(real), "both routes hash to one key");
  assert.equal(readSpawn(link)?.model, "real/model", "the link reads the same record");
  assert.equal(listSpawns().length, 1, "and does not create a second one");
});

test("a record naming a different folder is a miss, not another folder's defaults", () => {
  freshHome();
  const mine = folder("mine");
  const theirs = folder("theirs");
  writeSpawn(theirs, { model: "theirs/model" }, 1000);

  // Forge the collision: put THEIR record under MY key. 64 bits makes this
  // vanishingly unlikely in the wild, but answering with the wrong folder's model
  // and connectors is worse than answering with nothing, so it is checked.
  const dir = spawnDir(mine);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spawn.json"), JSON.stringify({ path: theirs, model: "theirs/model", connectors: [], createdAt: 1, lastOpenedAt: null }));

  assert.equal(readSpawn(mine), null, "the stored path disagrees → treated as no record");
});

test("a malformed or half-written record degrades to no record", () => {
  freshHome();
  const dir = folder("broken");
  const file = join(spawnDir(dir), "spawn.json");
  mkdirSync(spawnDir(dir), { recursive: true });

  writeFileSync(file, "{ not json");
  assert.equal(readSpawn(dir), null, "unparseable");

  writeFileSync(file, JSON.stringify({ model: "a/b" }));
  assert.equal(readSpawn(dir), null, "no path field");

  writeFileSync(file, JSON.stringify({ path: dir, model: 42, connectors: "github", createdAt: "x" }));
  const rec = readSpawn(dir);
  assert.equal(rec?.model, null, "a non-spec model is dropped, not surfaced");
  assert.deepEqual(rec?.connectors, [], "a non-array connectors list is dropped");
  assert.equal(rec?.createdAt, 0);
});

test("listSpawns skips unreadable entries rather than surfacing blanks", () => {
  freshHome();
  const good = folder("good");
  writeSpawn(good, { model: "a/b" }, 1000);
  // A directory under spawns/ with no record in it — e.g. a per-spawn skills dir
  // created before any defaults were saved.
  mkdirSync(join(spawnsDir(), "0123456789abcdef", "skills"), { recursive: true });

  const listed = listSpawns();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].path, good);
});

test("records are owner-only", () => {
  freshHome();
  const dir = folder("perms");
  writeSpawn(dir, { model: "a/b" }, 1000);
  assert.equal(statSync(join(spawnDir(dir), "spawn.json")).mode & 0o077, 0, "0600");
});

test("forgetSpawn removes the record and its skills; unknown folders are a no-op", () => {
  freshHome();
  const dir = folder("gone");
  writeSpawn(dir, { model: "a/b" }, 1000);
  mkdirSync(spawnSkillsDir(dir), { recursive: true });
  writeFileSync(join(spawnSkillsDir(dir), "SKILL.md"), "# test");

  assert.equal(forgetSpawn(dir), true);
  assert.equal(readSpawn(dir), null);
  assert.deepEqual(listSpawns(), []);
  assert.equal(forgetSpawn(dir), false, "already gone");
  assert.equal(forgetSpawn(folder("never-recorded")), false);
});

test("the JSON on disk is the documented shape", () => {
  freshHome();
  const dir = folder("shape");
  writeSpawn(dir, { model: "p/m", connectors: ["github"], lastOpenedAt: 7 }, 3);
  const raw = JSON.parse(readFileSync(join(spawnDir(dir), "spawn.json"), "utf8"));
  assert.deepEqual(Object.keys(raw).sort(), ["connectors", "createdAt", "lastOpenedAt", "model", "path"]);
});
