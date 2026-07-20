// Apply the patches/ directory into node_modules — at LAUNCH, not at install.
//
// Why not a `postinstall` script (the obvious place)? Because `npm install` /
// `npx privateer-agent` would then execute our code on the user's machine BEFORE
// they ever decided to run Privateer. That is exactly the install-time-execution
// risk a careful reviewer — human or agent — flags on an unfamiliar package, and
// it is the one npm-side signal we can remove outright. With no install scripts,
// `npm install -g privateer-agent --ignore-scripts` is completely inert: it writes
// files and runs nothing. Patching moves to the first actual launch, which the
// user explicitly asked for.
//
// Contract: idempotent, cheap on the hot path (a stamp file short-circuits every
// launch after the first), and BEST-EFFORT — every patch here is a UX/robustness
// improvement, never a correctness prerequisite, so a failure to apply degrades to
// stock Pi behaviour rather than blocking launch. That matters for the common
// `sudo npm install -g` case, where node_modules is root-owned and an unprivileged
// launch simply cannot write to it.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Bump when the applier's own semantics change, to force a re-apply on upgrade.
const STAMP_VERSION = 1;

/**
 * Where do our patch targets actually live?
 *
 * NOT necessarily `<repo>/node_modules`. When Privateer is installed as a dependency
 * (`npm i privateer-agent`, `npx privateer-agent`), npm HOISTS pi-coding-agent to the
 * parent project's node_modules and leaves us with no node_modules of our own — so
 * assuming a local one means the patches silently never apply. Resolve the real target
 * from our own package instead, and return the directory that CONTAINS the node_modules
 * it landed in: that is the cwd patch-package needs, in every layout (hoisted, nested,
 * global, bundled).
 */
/**
 * Find the directory CONTAINING the node_modules that holds `name`, starting at
 * `from` and walking up. Returns null if the dependency isn't installed anywhere.
 *
 * This is the one resolution primitive both the launcher and the patcher need,
 * because `<repo>/node_modules` is NOT where dependencies reliably live:
 *   - `npm i -g privateer-agent`  -> nested:  <repo>/node_modules/<name>
 *   - `npx privateer-agent`       -> hoisted: <repo>/../node_modules/<name>
 *   - `npm i privateer-agent`     -> hoisted into the host project
 * Hardcoding the nested case silently breaks every hoisted install.
 *
 * We walk directories rather than using require.resolve because modern packages
 * (pi-coding-agent among them) declare an `exports` map with no "./package.json"
 * entry, so require.resolve throws ERR_PACKAGE_PATH_NOT_EXPORTED even when the
 * package is sitting right there. Directory lookup sees through `exports`.
 */
export function findDepRoot(from, name) {
  const segs = name.split("/");
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "node_modules", ...segs, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // hit the filesystem root
  }
}

/** Absolute path to an installed dependency's file, or null if the dep isn't present. */
export function resolveDep(from, name, ...rest) {
  const root = findDepRoot(from, name);
  return root ? path.join(root, "node_modules", ...name.split("/"), ...rest) : null;
}

function resolvePatchRoots(repo, patchFiles) {
  const roots = new Set();
  for (const file of patchFiles) {
    // "@earendil-works+pi-coding-agent+0.80.3.patch" -> "@earendil-works/pi-coding-agent"
    const parts = path.basename(file, ".patch").split("+");
    const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    const root = findDepRoot(repo, name);
    if (root) roots.add(root);
  }
  return [...roots];
}

/** sha256 over every patch file's name + contents — the identity of "what should be applied". */
function patchSetHash(patchDir, files) {
  const h = crypto.createHash("sha256").update(String(STAMP_VERSION));
  for (const f of files) {
    h.update(f);
    h.update(fs.readFileSync(path.join(patchDir, f)));
  }
  return h.digest("hex");
}

/**
 * Ensure patches/ is applied to repo/node_modules. Returns one of:
 *   "current"   — already applied (stamp matches); nothing done
 *   "applied"   — patches were just applied successfully
 *   "skipped"   — nothing to do (no patches / no node_modules / patch-package absent)
 *   "failed"    — apply was attempted and did not succeed (caller may warn)
 */
export function applyPatchesIfNeeded(repo, nodeBin = process.execPath) {
  try {
    repo = path.resolve(repo); // roots come back absolute; a relative repo would break path.relative
    const patchDir = path.join(repo, "patches");
    if (!fs.existsSync(patchDir)) return "skipped";
    const patchFiles = fs.readdirSync(patchDir).filter((f) => f.endsWith(".patch")).sort();
    if (patchFiles.length === 0) return "skipped";

    const want = patchSetHash(patchDir, patchFiles);
    const roots = resolvePatchRoots(repo, patchFiles);
    if (roots.length === 0) return "skipped"; // targets not installed

    // patch-package is a runtime dependency precisely so this works post-install.
    const pp = resolveDep(repo, "patch-package", "index.js");
    if (!pp || !fs.existsSync(pp)) return "skipped";

    let did = false;
    for (const root of roots) {
      const stampFile = path.join(root, "node_modules", ".privateer-patches.json");
      try {
        if (JSON.parse(fs.readFileSync(stampFile, "utf8")).hash === want) continue; // current
      } catch { /* missing or unreadable stamp — (re)apply */ }

      // --patch-dir points at OUR patches even though cwd is wherever the deps landed.
      // It MUST be relative: patch-package resolves it against cwd, so an absolute path
      // is silently mangled into a non-existent one and every patch "fails" to apply.
      const relPatchDir = path.relative(root, patchDir);
      const r = spawnSync(nodeBin, [pp, "--error-on-fail", "--patch-dir", relPatchDir], {
        cwd: root,
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 60_000,
        windowsHide: true,
      });
      if (r.status !== 0) return "failed";
      did = true;

      // Only stamp after a clean apply, so a partial/failed run retries next launch.
      try {
        fs.writeFileSync(stampFile, JSON.stringify({ hash: want, at: new Date().toISOString() }) + "\n");
      } catch { /* unwritable node_modules — applied fine, we just re-check next launch */ }
    }
    return did ? "applied" : "current";
  } catch {
    return "failed";
  }
}
