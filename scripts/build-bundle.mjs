#!/usr/bin/env node
// Build a self-contained Privateer bundle for one (os, arch) target.
//
//   node scripts/build-bundle.mjs --target darwin-arm64
//   node scripts/build-bundle.mjs --target linux-x64 --node 22.19.0
//   node scripts/build-bundle.mjs --all           # every supported target
//
// A bundle removes the Node/npm requirement from the *user*: it ships a pinned
// Node runtime plus the fully-installed, patched, prod-only app tree, so the
// installer just downloads and extracts it. See docs (shipping model = "bundle").
//
// Why this can build every target from one machine: the node_modules tree is
// already cross-platform — koffi bundles all platform builds in one package, and
// pi-tui ships darwin+win32 prebuilds (Linux needs no native module). The ONLY
// per-target artifact is the Node binary, which we download from nodejs.org. We
// still prune the other platforms' natives out of each bundle to keep it lean.
//
// Requires Node + npm on the BUILD machine (not the user's). Network access to
// nodejs.org (Node dist) and the npm registry.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "dist-bundle");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

// Node pin: default to .nvmrc / engines floor.
const DEFAULT_NODE = (fs.existsSync(path.join(REPO, ".nvmrc"))
  ? fs.readFileSync(path.join(REPO, ".nvmrc"), "utf8").trim()
  : PKG.engines.node.replace(/[^\d.]/g, "")) || "22.19.0";

// Supported targets. os = node's process.platform; arch = process.arch.
const TARGETS = {
  "darwin-arm64": { os: "darwin", arch: "arm64", nodePkg: "darwin-arm64", ext: "tar.gz", archive: "tar.gz" },
  "darwin-x64":   { os: "darwin", arch: "x64",   nodePkg: "darwin-x64",   ext: "tar.gz", archive: "tar.gz" },
  "linux-x64":    { os: "linux",  arch: "x64",   nodePkg: "linux-x64",    ext: "tar.xz", archive: "tar.gz" },
  "linux-arm64":  { os: "linux",  arch: "arm64", nodePkg: "linux-arm64",  ext: "tar.xz", archive: "tar.gz" },
  "win32-x64":    { os: "win32",  arch: "x64",   nodePkg: "win-x64",      ext: "zip",    archive: "zip" },
  "win32-arm64":  { os: "win32",  arch: "arm64", nodePkg: "win-arm64",    ext: "zip",    archive: "zip" },
};

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const NODE_VERSION = getArg("node", DEFAULT_NODE).replace(/^v/, "");
const wantAll = argv.includes("--all");
const target = getArg("target", `${process.platform}-${process.arch}`);
const selected = wantAll ? Object.keys(TARGETS) : [target];

const log = (m) => console.log(`⚓ ${m}`);
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
const runOut = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

// ---- fetch + extract the pinned Node runtime ------------------------------
// We only need the single `node`/`node.exe` binary out of the dist archive.
function fetchNodeBinary(t, stageDir, cacheDir) {
  const base = `node-v${NODE_VERSION}-${t.nodePkg}`;
  const file = `${base}.${t.ext}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${file}`;
  const cached = path.join(cacheDir, file);
  if (!fs.existsSync(cached)) {
    log(`Downloading ${url}`);
    run("curl", ["-fsSL", "-o", cached, url]);
  } else {
    log(`Using cached ${file}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pv-node-"));
  try {
    if (t.ext === "zip") {
      run("unzip", ["-q", cached, "-d", tmp]);
      const src = path.join(tmp, base, "node.exe");
      fs.copyFileSync(src, path.join(stageDir, "node.exe"));
    } else {
      // tar handles both .gz and .xz.
      run("tar", ["-xf", cached, "-C", tmp]);
      const src = path.join(tmp, base, "bin", "node");
      const dst = path.join(stageDir, "node");
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o755);
    }
  } finally {
    rmrf(tmp);
  }
}

// Collect every directory under root (npm can hoist OR nest duplicate copies of a
// package, so we must prune ALL copies, not just the top-level path).
function allDirs(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        const full = path.join(d, e.name);
        out.push(full);
        stack.push(full);
      }
    }
  }
  return out;
}

// ---- prune cross-platform natives out of the installed tree ---------------
function pruneNatives(nm, t) {
  const dirs = allDirs(nm);
  const koffiTail = path.join("koffi", "build", "koffi");
  const piTuiTail = path.join("@earendil-works", "pi-tui", "native");

  // koffi: keep only this target's build dir (names like darwin_arm64, win32_x64,
  // musl_x64, …). Every copy in the tree.
  const keepKoffi = new Set([`${t.os}_${t.arch}`]);
  if (t.os === "linux") keepKoffi.add(`musl_${t.arch}`); // Alpine/musl users
  for (const d of dirs) {
    if (!d.endsWith(koffiTail) || !fs.existsSync(d)) continue;
    for (const sub of fs.readdirSync(d)) if (!keepKoffi.has(sub)) rmrf(path.join(d, sub));
  }

  // pi-tui native: keep only this OS's prebuild subtree, and within it this arch.
  for (const d of dirs) {
    if (!d.endsWith(piTuiTail) || !fs.existsSync(d)) continue;
    for (const osDir of fs.readdirSync(d)) {
      if (osDir !== t.os) { rmrf(path.join(d, osDir)); continue; }
      const pre = path.join(d, osDir, "prebuilds");
      if (!fs.existsSync(pre)) continue;
      for (const p of fs.readdirSync(pre)) {
        if (!p.startsWith(`${t.os}-${t.arch}`)) rmrf(path.join(pre, p));
      }
    }
  }

  // fsevents is macOS-only (optional dep). Drop every copy on non-darwin.
  if (t.os !== "darwin") {
    for (const d of dirs) {
      if (path.basename(d) === "fsevents" && fs.existsSync(d)) rmrf(d);
    }
  }
}

// ---- strip runtime-dead weight from the installed tree --------------------
// Removes things never needed to RUN the code, and here they're enormous:
//   • debug symbols  — a mis-published hypa.dSYM alone is ~102 MB
//   • source maps    — ~105 MB of *.map
//   • TS declarations — ~80 MB of *.d.ts (types are erased at runtime; jiti/tsx
//                       transpile the .ts SOURCE we load and never read .d.ts)
// It does NOT remove *.ts source: our moat shims import real .ts entrypoints from
// node_modules (rpiv-web-tools/index.ts, pi-subagents/src/extension/index.ts, …).
const DEAD_FILE = (n) =>
  n.endsWith(".map") || n.endsWith(".pdb") ||
  n.endsWith(".d.ts") || n.endsWith(".d.cts") || n.endsWith(".d.mts");

function slimTree(nm) {
  const dirs = allDirs(nm);
  let freedDirs = 0;
  // .dSYM (macOS debug symbol bundles) — whole directories.
  for (const d of dirs) {
    if (d.endsWith(".dSYM") && fs.existsSync(d)) { rmrf(d); freedDirs++; }
  }
  // Dead files — walk fresh so we skip paths already removed with a .dSYM above.
  let freedFiles = 0;
  const stack = [nm];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && DEAD_FILE(e.name)) {
        try { fs.rmSync(full); freedFiles++; } catch { /* ignore */ }
      }
    }
  }
  log(`Slimmed: removed ${freedDirs} debug-symbol dir(s), ${freedFiles} map/decl/pdb file(s)`);
}

// ---- assemble one bundle --------------------------------------------------
function buildTarget(name) {
  const t = TARGETS[name];
  if (!t) throw new Error(`unknown target "${name}" (valid: ${Object.keys(TARGETS).join(", ")})`);

  log(`Building ${name} (node v${NODE_VERSION})`);
  const stage = path.join(OUT, `privateer-${name}`);
  const cacheDir = path.join(OUT, ".node-cache");
  rmrf(stage);
  mkdirp(stage);
  mkdirp(cacheDir);

  // 1. Prod-only install with patches, into a clean staging tree. We copy the
  //    manifest + lockfile + patches so `npm ci` reproduces exactly and the
  //    postinstall (patch-package) applies our pi-coding-agent patch.
  // --os/--cpu make npm fetch the TARGET platform's os/cpu-gated optionalDependencies
  // (e.g. @mariozechner/clipboard-<plat>, fsevents) rather than the build host's — so
  // any host can assemble a correct bundle for any target. (koffi/pi-tui bundle all
  // platforms in one package, so those are handled by pruneNatives instead.)
  log(`Installing prod dependencies (npm ci --omit=dev --os=${t.os} --cpu=${t.arch})`);
  for (const f of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(REPO, f), path.join(stage, f));
  }
  fs.cpSync(path.join(REPO, "patches"), path.join(stage, "patches"), { recursive: true });
  run("npm", ["ci", "--omit=dev", `--os=${t.os}`, `--cpu=${t.arch}`], { cwd: stage });

  // 2. App code.
  for (const dir of ["src", "extensions", "bin"]) {
    fs.cpSync(path.join(REPO, dir), path.join(stage, dir), { recursive: true });
  }
  for (const f of ["README.md", "LICENSE"]) {
    const p = path.join(REPO, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(stage, f));
  }
  // Stamp the bundle so the launcher/telemetry can tell it's a bundle install.
  fs.writeFileSync(
    path.join(stage, "BUNDLE_INFO.json"),
    JSON.stringify({ target: name, node: NODE_VERSION, version: PKG.version, channel: "bundle" }, null, 2) + "\n",
  );

  // 3. Pinned Node runtime + native pruning + dead-weight slimming.
  fetchNodeBinary(t, stage, cacheDir);
  pruneNatives(path.join(stage, "node_modules"), t);
  slimTree(path.join(stage, "node_modules"));

  // 4. Archive.
  const archiveName = `privateer-${name}.${t.archive}`;
  const archivePath = path.join(OUT, archiveName);
  rmrf(archivePath);
  log(`Packing ${archiveName}`);
  if (t.archive === "zip") {
    // -y stores symlinks as-is; run from OUT so the top dir is privateer-<name>/.
    run("zip", ["-qry", archivePath, `privateer-${name}`], { cwd: OUT });
  } else {
    run("tar", ["-czf", archivePath, "-C", OUT, `privateer-${name}`]);
  }

  // 5. Checksum.
  const buf = fs.readFileSync(archivePath);
  const sha = createHash("sha256").update(buf).digest("hex");
  fs.writeFileSync(`${archivePath}.sha256`, `${sha}  ${archiveName}\n`);

  const mb = (buf.length / 1024 / 1024).toFixed(1);
  log(`✓ ${archiveName}  (${mb} MB)  sha256=${sha.slice(0, 16)}…`);
  return { name, archivePath, sha, bytes: buf.length };
}

// ---- main -----------------------------------------------------------------
mkdirp(OUT);
log(`Node on build machine: ${runOut("node", ["-v"])}`);
const results = [];
for (const name of selected) results.push(buildTarget(name));

console.log("");
log("Done:");
for (const r of results) {
  console.log(`   ${path.relative(REPO, r.archivePath)}  ${(r.bytes / 1024 / 1024).toFixed(1)} MB`);
}
