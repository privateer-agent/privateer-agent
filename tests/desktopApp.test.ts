import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { desktopAppPath, desktopDownloadAltUrl, desktopDownloadUrl } from "../src/config/desktopApp.ts";

// src/config/desktopApp.ts decides two user-visible things: whether /desktop opens
// the app or offers a download, and whether the working-line tip mentions it at all
// (privateer-hints.ts stays silent on a machine without the app). Both hang off
// path detection, which is pure apart from existsSync — so the platform, env and
// execPath are injectable and this test can check all three routes on any host.

const root = mkdtempSync(join(tmpdir(), "privateer-desktop-"));
const mkdir = (...p: string[]): string => {
  const dir = join(root, ...p);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const mkfile = (dir: string, name: string): string => {
  const path = join(dir, name);
  writeFileSync(path, "");
  return path;
};

test("macOS: the app bundle we are RUNNING inside wins", () => {
  // The desktop's CLI shim runs `privateer` on the app's own binary, so execPath is
  // inside the bundle — and that copy is the installed one wherever the user put it.
  const bundle = mkdir("Somewhere Else", "Privateer.app");
  mkdir("Somewhere Else", "Privateer.app", "Contents", "MacOS");
  const exec = join(bundle, "Contents", "MacOS", "Privateer");
  assert.equal(desktopAppPath("darwin", {}, exec), bundle);
});

test("macOS: without a bundle around us, only the standard locations answer", () => {
  // A plain `node` execPath falls through to /Applications and ~/Applications, which
  // are absolute and so can't be faked — the assertion is on the SHAPE: either the
  // machine has an install there, or nothing is claimed. (A stray answer of any other
  // path would mean the fallback had started guessing.)
  const found = desktopAppPath("darwin", {}, "/usr/local/bin/node");
  assert.ok(
    found === null || found === "/Applications/Privateer.app" || found === join(homedir(), "Applications", "Privateer.app"),
    `unexpected fallback: ${found}`,
  );
});

test("windows: LOCALAPPDATA install is found; a missing one is null", () => {
  const dir = mkdir("Local", "Programs", "Privateer");
  const exe = mkfile(dir, "Privateer.exe");
  const env = { LOCALAPPDATA: join(root, "Local") };
  assert.equal(desktopAppPath("win32", env, "C:\\Program Files\\nodejs\\node.exe"), exe);
  assert.equal(desktopAppPath("win32", { LOCALAPPDATA: join(root, "Nothing") }, "node.exe"), null);
});

test("windows: Program Files install is found when LOCALAPPDATA has none", () => {
  const dir = mkdir("PF", "Privateer");
  const exe = mkfile(dir, "Privateer.exe");
  const env = { LOCALAPPDATA: join(root, "Empty"), ProgramFiles: join(root, "PF") };
  assert.equal(desktopAppPath("win32", env, "node.exe"), exe);
});

test("linux has no desktop build: no path, no download page", () => {
  assert.equal(desktopAppPath("linux", {}, "/usr/bin/node"), null);
  assert.equal(desktopDownloadUrl("linux", "x64"), null);
});

test("the macOS download page follows the arch, and offers the other build", () => {
  assert.match(desktopDownloadUrl("darwin", "arm64")!, /download\/mac$/);
  assert.match(desktopDownloadAltUrl("darwin", "arm64")!, /download\/mac-intel$/);
  assert.match(desktopDownloadUrl("darwin", "x64")!, /download\/mac-intel$/);
  assert.match(desktopDownloadAltUrl("darwin", "x64")!, /download\/mac$/);

  // One Windows installer, so nothing to offer alongside it.
  assert.match(desktopDownloadUrl("win32", "x64")!, /download\/windows$/);
  assert.equal(desktopDownloadAltUrl("win32", "x64"), null);

  rmSync(root, { recursive: true, force: true });
});
