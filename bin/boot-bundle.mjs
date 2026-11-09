// Which Pi entry should this launch run: the compiled boot build, or the source tree?
// scripts/build-boot.mjs makes the build; docs/startup-performance.md explains why.
//
// The answer is the build only when it is certainly the same code as the source next
// to it. Every other case returns null and the launcher runs from source, which is
// slower and always correct, so nothing here is ever a reason a launch fails.

import fs from "node:fs";
import path from "node:path";

export const BOOT_DIR = "dist-boot";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Absolute path of the build's entry script, or null to run from source. */
export function bootCliPath(repo, env = process.env) {
  if (env.PRIVATEER_NO_BOOT_BUNDLE === "1") return null;

  // A checkout is where source gets edited, and the build wouldn't see those edits.
  if (fs.existsSync(path.join(repo, ".git")) && env.PRIVATEER_BOOT_BUNDLE !== "1") return null;

  const dir = path.join(repo, BOOT_DIR);
  const manifest = readJson(path.join(dir, "manifest.json"));
  if (!manifest) return null;

  // A build left behind by an upgrade is older code wearing the new version's name.
  const pkg = readJson(path.join(repo, "package.json"));
  if (!pkg || manifest.version !== pkg.version) return null;

  // The build maps each file back to its place under <repo>/node_modules. A hoisted
  // install (npx, or a dependency of another project) has no such place.
  if (!fs.existsSync(path.join(repo, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"))) {
    return null;
  }

  const entry = path.join(dir, "boot.mjs");
  return fs.existsSync(entry) && fs.existsSync(path.join(dir, "cli.mjs")) ? entry : null;
}
