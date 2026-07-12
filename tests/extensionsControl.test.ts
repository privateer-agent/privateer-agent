import { test } from "node:test";
import assert from "node:assert/strict";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { makeExtensionsControl } from "../src/remote/extensionsControl.ts";

// extensionsControl wraps Pi's PackageManager. These tests exercise the pure paths —
// listing (maps configured "packages") and input guards — without touching npm/git:
// add()/remove() shell out, so we only assert their no-network rejection branches.

function control(packages: string[]) {
  const settingsManager = SettingsManager.inMemory({ packages });
  return makeExtensionsControl({ cwd: "/work", agentDir: "/work/.agent", settingsManager });
}

test("listInstalled maps the user's configured packages", () => {
  const installed = control(["npm:pi-hello", "npm:@scope/pi-thing@1.2.3"]).listInstalled();
  const sources = installed.map((e) => e.source).sort();
  assert.deepEqual(sources, ["npm:@scope/pi-thing@1.2.3", "npm:pi-hello"]);
  for (const e of installed) assert.equal(e.scope, "user");
});

test("listInstalled excludes the Privateer moat even if hand-added to settings", () => {
  // The moat normally lives as shims (not "packages"), but guard defensively.
  const installed = control(["npm:pi-hello", "npm:pi-privacy", "npm:@juicesharp/rpiv-web-tools", "pi-subagents"]).listInstalled();
  assert.deepEqual(installed.map((e) => e.source), ["npm:pi-hello"]);
});

test("listInstalled is empty with no configured packages", () => {
  assert.deepEqual(control([]).listInstalled(), []);
});

test("add rejects an empty source without touching npm", async () => {
  const res = await control([]).add("   ");
  assert.equal(res.ok, false);
});

test("add refuses to manage a reserved Privateer package", async () => {
  const res = await control([]).add("npm:pi-privacy");
  assert.equal(res.ok, false);
  assert.match(res.message ?? "", /Privateer/);
});

test("remove rejects an empty source without touching npm", async () => {
  const res = await control([]).remove("");
  assert.equal(res.ok, false);
});
