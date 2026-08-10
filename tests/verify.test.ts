import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verify } from "../bin/privateer-verify.mjs";

// `privateer verify` is the only trust check a user can run AFTER installing, so the
// thing it must never do is report a pass it did not make. These tests pin the three
// outcomes apart: a real failure exits 1, an inconclusive check does not, and a
// dependency declared as a range is never counted as matching a pin it doesn't have
// (that was the first version's bug — it reported "24 dependencies match their pinned
// versions" for a package.json where only 2 were pinned).

function scratch(name: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pv-verify-${name}-`)));
}

/** A fake install: privateer-agent at the root, deps nested under it. */
function install(deps: Record<string, string>, resolved: Record<string, string>): string {
  const repo = scratch("tree");
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "privateer-agent", version: "9.9.9", dependencies: deps }),
  );
  for (const [name, version] of Object.entries(resolved)) {
    const dir = path.join(repo, "node_modules", ...name.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  }
  return repo;
}

/** Run verify with stdout captured, so the suite output stays readable. */
async function run(repo: string): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  try {
    const code = await verify({ repo, offline: true });
    return { code, out: chunks.join("\n") };
  } finally {
    console.log = realLog;
  }
}

test("an exactly-pinned tree that matches passes", async () => {
  const repo = install({ ws: "8.21.0", zod: "4.4.3" }, { ws: "8.21.0", zod: "4.4.3" });
  const { code, out } = await run(repo);
  assert.equal(code, 0);
  assert.match(out, /2 direct dependencies match their exact pin/);
  assert.doesNotMatch(out, /differ from the pinned version/);
});

test("a dependency swapped under an exact pin FAILS, and names the drift", async () => {
  const repo = install({ ws: "8.21.0", zod: "4.4.3" }, { ws: "8.21.0", zod: "9.0.0" });
  const { code, out } = await run(repo);
  assert.equal(code, 1);
  assert.match(out, /1 dependency differs from the pinned version/);
  assert.match(out, /zod 4\.4\.3 → 9\.0\.0/);
});

test("a range-declared dependency is reported as uncheckable, never as a match", async () => {
  // The pre-0.12.9 shape: caret ranges, so the resolved version is legitimately
  // free to differ. That is inconclusive, not a pass and not a failure.
  const repo = install({ ws: "^8.21.0" }, { ws: "8.30.0" });
  const { code, out } = await run(repo);
  assert.equal(code, 0, "a range is not a failure");
  assert.match(out, /1 direct dependency is declared as a range/);
  assert.doesNotMatch(out, /match their exact pin/);
  assert.doesNotMatch(out, /1 direct dependency matches its exact pin/);
});

test("inconclusive checks do not turn into a failing exit code", async () => {
  const repo = install({ ws: "8.21.0" }, {}); // declared but not installed
  const { code, out } = await run(repo);
  assert.equal(code, 0);
  assert.match(out, /not found on disk/);
  assert.match(out, /inconclusive/);
});

test("verdict state does not leak between runs", async () => {
  // The counters are module-level; a second call used to inherit the first's failures.
  const bad = install({ zod: "4.4.3" }, { zod: "9.0.0" });
  const good = install({ zod: "4.4.3" }, { zod: "4.4.3" });
  assert.equal((await run(bad)).code, 1);
  assert.equal((await run(good)).code, 0, "a clean tree must not inherit the previous failure");
});
