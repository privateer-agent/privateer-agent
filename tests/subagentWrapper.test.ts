import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain-JS wrapper with no .d.ts; the exports are pure functions.
import { buildChildArgs, moatExtensionPaths, piCliPath } from "../bin/privateer-subagent.mjs";

// The child-spawn wrapper's arg construction: it must inject --no-extensions + the
// moat -e flags BEFORE pi-subagents' original args, and never drop the original args
// (incl. the positional Task: prompt).

const REPO = "/repo";

test("injects --no-extensions and one -e per moat extension, before the originals", () => {
  const original = ["--mode", "json", "-p", "--model", "tinfoil/glm", "Task: do it"];
  const out = buildChildArgs(original, REPO);
  // --no-extensions leads.
  assert.equal(out[0], "--no-extensions");
  // three -e pairs follow (gate, privacy, account).
  const es = out.filter((a: string) => a === "-e");
  assert.equal(es.length, 3);
  // originals are preserved contiguously at the tail (order intact).
  assert.deepEqual(out.slice(out.length - original.length), original);
});

test("moat paths are the three privateer entry extensions under the given repo", () => {
  const paths = moatExtensionPaths(REPO);
  assert.deepEqual(paths, [
    "/repo/extensions/privateer-gate.ts",
    "/repo/extensions/privateer-privacy.ts",
    "/repo/extensions/privateer-account.ts",
  ]);
  // every injected -e path is one of the moat paths.
  const out = buildChildArgs(["Task: x"], REPO);
  const injected = out.filter((_: string, i: number) => out[i - 1] === "-e");
  assert.deepEqual(injected.sort(), [...paths].sort());
});

test("the positional prompt stays last", () => {
  const out = buildChildArgs(["--mode", "json", "-p", "Task: the work"], REPO);
  assert.equal(out[out.length - 1], "Task: the work");
});

test("piCliPath resolves the bundled pi under the repo", () => {
  assert.equal(piCliPath(REPO), "/repo/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
});

test("empty original args still yields a valid injection", () => {
  const out = buildChildArgs([], REPO);
  assert.equal(out[0], "--no-extensions");
  assert.equal(out.filter((a: string) => a === "-e").length, 3);
});
