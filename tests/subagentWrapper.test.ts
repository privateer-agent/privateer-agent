import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
// @ts-expect-error — plain-JS wrapper with no .d.ts; the exports are pure functions.
import { buildChildArgs, moatExtensionPaths, piCliPath } from "../bin/privateer-subagent.mjs";

// The child-spawn wrapper's arg construction: it must inject --no-extensions + the
// moat -e flags BEFORE pi-subagents' original args, and never drop the original args
// (incl. the positional Task: prompt).
//
// This is the ONLY route by which the moat reaches a subagent child — since the moat
// stopped being installed as discovery shims, a child spawned without these flags runs
// ungated. So the tests pass an explicit env rather than reading the ambient one: a stray
// PRIVATEER_CHILD_EXTENSIONS in the developer's shell must not change what they prove.

const REPO = "/repo";
const NO_ENV = {};
const FALLBACK = [
  "/repo/extensions/privateer-gate.ts",
  "/repo/extensions/privateer-privacy.ts",
  "/repo/extensions/privateer-account.ts",
  "/repo/extensions/privateer-media.ts",
];

test("injects --no-extensions and one -e per moat extension, before the originals", () => {
  const original = ["--mode", "json", "-p", "--model", "tinfoil/glm", "Task: do it"];
  const out = buildChildArgs(original, REPO, NO_ENV);
  // --no-extensions leads.
  assert.equal(out[0], "--no-extensions");
  // one -e pair per fallback extension (gate, privacy, account, media).
  const es = out.filter((a: string) => a === "-e");
  assert.equal(es.length, FALLBACK.length);
  // originals are preserved contiguously at the tail (order intact).
  assert.deepEqual(out.slice(out.length - original.length), original);
});

test("moat paths fall back to the privateer entry extensions under the given repo", () => {
  const paths = moatExtensionPaths(REPO, NO_ENV);
  assert.deepEqual(paths, FALLBACK);
  // every injected -e path is one of the moat paths.
  const out = buildChildArgs(["Task: x"], REPO, NO_ENV);
  const injected = out.filter((_: string, i: number) => out[i - 1] === "-e");
  assert.deepEqual(injected.sort(), [...paths].sort());
});

// A child of the TUI must get the TUI's moat, not the headless fallback — the launcher
// hands its own `-e` list down through PRIVATEER_CHILD_EXTENSIONS so the two can't drift.
test("moat paths follow the parent's list when it hands one down", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-child-ext-"));
  try {
    const a = join(dir, "one.ts");
    const b = join(dir, "two.ts");
    for (const p of [a, b]) writeFileSync(p, "export default function (pi) {}\n");
    const env = { PRIVATEER_CHILD_EXTENSIONS: [a, b].join(delimiter) };

    assert.deepEqual(moatExtensionPaths(REPO, env), [a, b]);
    const out = buildChildArgs(["Task: x"], REPO, env);
    assert.deepEqual(
      out.filter((_: string, i: number) => out[i - 1] === "-e"),
      [a, b],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// An inherited path that no longer exists (a tool pack dropped by an upgrade, a stale
// env in a long-lived shell) must not be passed to Pi, which would fail the load. If
// every inherited path is gone we are better off with the floor than with nothing.
test("moat paths drop inherited entries that no longer exist, falling back if all are gone", () => {
  const env = { PRIVATEER_CHILD_EXTENSIONS: ["/nope/gone.ts", "/nope/also-gone.ts"].join(delimiter) };
  assert.deepEqual(moatExtensionPaths(REPO, env), FALLBACK);
  assert.deepEqual(moatExtensionPaths(REPO, { PRIVATEER_CHILD_EXTENSIONS: "" }), FALLBACK);
});

test("the positional prompt stays last", () => {
  const out = buildChildArgs(["--mode", "json", "-p", "Task: the work"], REPO, NO_ENV);
  assert.equal(out[out.length - 1], "Task: the work");
});

test("piCliPath resolves the bundled pi under the repo", () => {
  assert.equal(piCliPath(REPO), "/repo/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
});

test("empty original args still yields a valid injection", () => {
  const out = buildChildArgs([], REPO, NO_ENV);
  assert.equal(out[0], "--no-extensions");
  assert.equal(out.filter((a: string) => a === "-e").length, FALLBACK.length);
});
