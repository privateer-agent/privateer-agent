import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findDepRoot, resolveDep, applyPatchesIfNeeded } from "../bin/apply-patches.mjs";

// Regression: `npx privateer-agent` was broken for a month and nobody saw it.
//
// Two independent bugs, both from assuming dependencies live at <repo>/node_modules:
//   1. The `postinstall` (patch-package --error-on-fail) ran with cwd = the package
//      dir. npm only NESTS deps there for a global install; `npx` and `npm i` HOIST
//      them to a parent node_modules, so patch-package found nothing, exited non-zero
//      and npm aborted the whole install — silently, with no output.
//   2. The launcher resolved Pi's cli.js the same hardcoded way, so even without the
//      postinstall it would have pointed at a file that wasn't there.
//
// Both are fixed by resolving through the node_modules CHAIN. These tests build the
// hoisted layout explicitly, because that is the one the dev repo never exercises.

/** Build a throwaway tree and return its root. */
function scratch(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pv-patch-${name}-`));
  return fs.realpathSync(dir); // macOS /var -> /private/var, so comparisons hold
}

function writePkg(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
}

test("findDepRoot resolves a HOISTED dependency (the npx / npm-install layout)", () => {
  const root = scratch("hoisted");
  const repo = path.join(root, "node_modules", "privateer-agent");
  writePkg(repo, "privateer-agent");
  // The dependency sits BESIDE us, not under us — no <repo>/node_modules at all.
  writePkg(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent"), "pi");

  assert.equal(findDepRoot(repo, "@earendil-works/pi-coding-agent"), root);
  assert.equal(
    resolveDep(repo, "@earendil-works/pi-coding-agent", "dist", "cli.js"),
    path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
  );
});

test("findDepRoot prefers the NESTED dependency (the global-install layout)", () => {
  const root = scratch("nested");
  const repo = path.join(root, "node_modules", "privateer-agent");
  writePkg(repo, "privateer-agent");
  // Present in BOTH places: the nested copy is the one Node would load, so it wins.
  writePkg(path.join(repo, "node_modules", "@earendil-works", "pi-coding-agent"), "pi-nested");
  writePkg(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent"), "pi-hoisted");

  assert.equal(findDepRoot(repo, "@earendil-works/pi-coding-agent"), repo);
});

test("findDepRoot returns null when the dependency is absent anywhere up the chain", () => {
  const repo = scratch("absent");
  writePkg(repo, "privateer-agent");
  assert.equal(findDepRoot(repo, "@earendil-works/pi-coding-agent"), null);
  assert.equal(resolveDep(repo, "@earendil-works/pi-coding-agent", "dist", "cli.js"), null);
});

test("applyPatchesIfNeeded is a no-op (not a failure) when there is nothing to patch", () => {
  const repo = scratch("nopatch");
  writePkg(repo, "privateer-agent");
  // No patches/ dir at all.
  assert.equal(applyPatchesIfNeeded(repo), "skipped");

  // patches/ present, but the target package isn't installed — still not a failure,
  // since a partial checkout must not wedge launch.
  fs.mkdirSync(path.join(repo, "patches"));
  fs.writeFileSync(path.join(repo, "patches", "@earendil-works+pi-coding-agent+0.80.3.patch"), "");
  assert.equal(applyPatchesIfNeeded(repo), "skipped");
});

test("the published package declares NO install scripts", () => {
  // The whole point of moving patching to launch time: `npm install privateer-agent`
  // must not execute our code before the user has decided to run anything. If someone
  // reintroduces a postinstall, this fails loudly.
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.ok(!pkg.scripts?.[hook], `package.json must not define a "${hook}" script`);
  }
});
