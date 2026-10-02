import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The banner's What's New list must be reviewed for every release: `reviewedFor` in
// src/config/whatsNew.json has to equal package.json's version, or release.yml stops
// before building. This test catches it earlier, at `npm test`, before anyone tags.

// @ts-expect-error — a dependency-free .mjs script, untyped on purpose
const { whatsNewProblems } = await import("../scripts/check-whats-new.mjs");

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const list = read("../src/config/whatsNew.json");
const pkg = read("../package.json");

test("the shipped What's New is reviewed for this version and well-formed", () => {
  assert.deepEqual(whatsNewProblems(list, pkg.version), []);
});

test("a version bump without a review is refused, with what to do", () => {
  // Against THIS release, not a pinned one: the shipped list's newest entry is always
  // `since` the current version, which a hard-coded older release would also flag.
  const v = pkg.version.replace(/\./g, "\\.");
  const problems: string[] = whatsNewProblems({ ...list, reviewedFor: "0.0.1" }, pkg.version);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, new RegExp(`reviewed for 0\\.0\\.1.*${v}.*"reviewedFor": "${v}"`, "s"));
});

test("entries: text, a slash cmd, a since no later than the release, newest first, four at most", () => {
  const ok = { text: "x", since: "0.1.0" };
  const check = (items: unknown[]) => whatsNewProblems({ reviewedFor: "0.2.0", items }, "0.2.0");
  assert.deepEqual(check([ok]), []);
  assert.equal(check([]).length, 1);
  assert.equal(check([ok, ok, ok, ok, ok]).length, 1);
  assert.match(check([{ text: "x" }])[0], /needs "since"/);
  assert.match(check([{ text: "x", since: "0.3.0" }])[0], /after 0\.2\.0/);
  assert.match(check([{ text: "x", cmd: "term", since: "0.1.0" }])[0], /slash command/);
  assert.match(check([ok, { text: "y", since: "0.2.0" }])[0], /newest first/);
});
