/**
 * The housekeeping an always-on box needs: config written atomically, routine output
 * and the service log kept bounded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/util/atomicWrite.ts";
import { rotateLogIfLarge } from "../src/harbor/logRotate.ts";
import { pruneRoutineOutput, writeRoutineOutput, routineOutputDir } from "../src/routines/store.ts";

const DIR = mkdtempSync(join(tmpdir(), "priv-housekeeping-"));
test.after(() => rmSync(DIR, { recursive: true, force: true }));
const posix = process.platform !== "win32";

test("writeFileAtomic replaces the file and leaves no temp files behind", () => {
  const p = join(DIR, "config.json");
  writeFileAtomic(p, '{"a":1}\n');
  writeFileAtomic(p, '{"a":2}\n');
  assert.equal(readFileSync(p, "utf8"), '{"a":2}\n');
  assert.deepEqual(readdirSync(DIR).filter((f) => f.endsWith(".tmp")), []);
});

test("writeFileAtomic: new files are owner-only, existing permissions are kept", { skip: !posix }, () => {
  const fresh = join(DIR, "fresh.json");
  writeFileAtomic(fresh, "{}");
  assert.equal(statSync(fresh).mode & 0o777, 0o600);

  const shared = join(DIR, "shared.json");
  writeFileSync(shared, "{}");
  chmodSync(shared, 0o640);
  writeFileAtomic(shared, '{"b":1}');
  assert.equal(statSync(shared).mode & 0o777, 0o640, "someone chose these permissions; keep them");
});

test("writeFileAtomic writes through a symlinked config instead of replacing the link", { skip: !posix }, () => {
  const real = join(DIR, "dotfiles-config.json");
  const link = join(DIR, "linked.json");
  writeFileSync(real, "{}");
  symlinkSync(real, link);
  writeFileAtomic(link, '{"c":1}');
  assert.ok(lstatSync(link).isSymbolicLink(), "still a link");
  assert.equal(readFileSync(real, "utf8"), '{"c":1}');
});

test("pruneRoutineOutput keeps the newest N dated results and nothing else is touched", () => {
  const dir = join(DIR, "out");
  mkdirSync(dir);
  const names = Array.from({ length: 5 }, (_, i) => `2026-10-0${i + 1}T07-00-00-000Z.md`);
  for (const n of names) writeFileSync(join(dir, n), n);
  writeFileSync(join(dir, "latest.md"), "x");
  writeFileSync(join(dir, "my-notes.md"), "mine");
  assert.equal(pruneRoutineOutput(dir, 2), 3);
  assert.deepEqual(readdirSync(dir).sort(), ["2026-10-04T07-00-00-000Z.md", "2026-10-05T07-00-00-000Z.md", "latest.md", "my-notes.md"]);
});

test("writeRoutineOutput prunes as it writes, and writes owner-only", async () => {
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = join(DIR, "home");
  try {
    const dir = routineOutputDir("hourly");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `2026-01-01T00-00-${String(i).padStart(2, "0")}-000Z.md`), "old");
    const latest = writeRoutineOutput("hourly", "new");
    assert.equal(readFileSync(latest, "utf8"), "new");
    const dated = readdirSync(dir).filter((f) => f !== "latest.md");
    assert.equal(dated.length, 30, "bounded at ROUTINE_OUTPUT_KEEP");
    if (posix) assert.equal(statSync(latest).mode & 0o777, 0o600);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
  }
});

test("rotateLogIfLarge copies aside and truncates in place, so an O_APPEND writer carries on", () => {
  const log = join(DIR, "harbor.log");
  // launchd holds the log open O_APPEND across our rotation; model that with a live fd.
  const fd = openSync(log, "a");
  writeSync(fd, "x".repeat(2000));
  assert.equal(rotateLogIfLarge(log, 1000), true);
  assert.equal(readFileSync(`${log}.1`, "utf8").length, 2000, "previous log kept");
  writeSync(fd, "after\n");
  closeSync(fd);
  assert.equal(readFileSync(log, "utf8"), "after\n", "the writer continued at the new end — no hole of NULs");

  assert.equal(rotateLogIfLarge(log, 1000), false, "small enough: left alone");
  assert.equal(rotateLogIfLarge(join(DIR, "absent.log"), 1), false, "no file (Linux journal): no-op");
  assert.equal(existsSync(join(DIR, "absent.log.1")), false);
});
