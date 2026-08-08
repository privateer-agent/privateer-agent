import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Every launcher in bin/ hands a LOCAL PATH to dynamic import(), and on Windows
 * that has to be a file:// URL.
 *
 * The bug this pins shipped in all three launchers at once and hid for months.
 * `import("D:\\repo\\src\\cli\\chat.ts")` throws ERR_UNSUPPORTED_ESM_URL_SCHEME
 * — Node reads the drive letter as the URL scheme "d:" — so `privateer`,
 * `privateer harbor` and `privateer acp` all died on Windows before executing a
 * line of our code. On POSIX the same expression works, so nothing local ever
 * complained, and `privateer --version` is answered upstream in
 * privateer-launch.mjs without reaching any of them: the Windows release smoke
 * test booted the bundle green while the command itself was dead.
 *
 * A live check can only cover the launcher CI actually runs (the harbor, on the
 * windows-latest runner). This one covers the whole class, on every machine, in
 * milliseconds — which is the right trade for a bug whose entire nature is
 * "correct on the platform you developed it on".
 *
 * If a launcher legitimately imports a bare specifier ("tsx/esm/api"), that is
 * untouched: only a *path* needs the conversion, and only paths are matched.
 */
const BIN = resolve(import.meta.dirname, "..", "bin");

test("launchers: dynamic imports of local paths go through pathToFileURL", () => {
  const files = readdirSync(BIN).filter((f) => f.endsWith(".mjs"));
  assert.ok(files.length > 0, "no launchers found — did bin/ move?");

  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(join(BIN, file), "utf8");
    // import(resolve(...)) / import(join(...)) / import(path.resolve(...)) —
    // a path builder handed straight to import(), with no URL conversion.
    const bad = src.match(/import\(\s*(?:path\.)?(?:resolve|join)\s*\(/g);
    if (bad) offenders.push(`${file}: ${bad.length} × import(<path>)`);
  }

  assert.deepEqual(
    offenders,
    [],
    `dynamic import() of a raw path breaks on Windows — wrap it: ` +
      `import(pathToFileURL(resolve(...)).href)\n  ${offenders.join("\n  ")}`,
  );
});

test("launchers: the ones that import a path import pathToFileURL to do it", () => {
  const files = readdirSync(BIN).filter((f) => f.endsWith(".mjs"));
  for (const file of files) {
    const src = readFileSync(join(BIN, file), "utf8");
    if (!src.includes("pathToFileURL(")) continue; // imports no local path
    assert.ok(
      /import\s*\{[^}]*\bpathToFileURL\b[^}]*\}\s*from\s*"node:url"/.test(src),
      `${file}: uses pathToFileURL() without importing it from node:url`,
    );
  }
});
