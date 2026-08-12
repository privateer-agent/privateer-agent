/**
 * The login-service unit the harbor installs.
 *
 * The restart policy is load-bearing and was wrong: launchd `KeepAlive: true`
 * restarts the harbor even after a CLEAN exit, so the harbor that finds another one
 * already holding the machine lock (a clean exit 0 by design) was relaunched every
 * ~10s forever, appending the same "already running" line to harbor.log — millions of
 * bytes of it, drowning the boot errors the log exists to show. `{ SuccessfulExit:
 * false }` restarts on a crash only, matching the systemd unit's Restart=on-failure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchdPlist, unitNeedsRefresh, unitIsStale, unitProgramPaths } from "../src/harbor/service.ts";

const DIR = mkdtempSync(join(tmpdir(), "priv-service-"));
test.after(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

test("launchd plist restarts on crash only, never after a clean exit", () => {
  const plist = launchdPlist();
  assert.match(
    plist,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\s*\/>\s*<\/dict>/,
    "KeepAlive must be the SuccessfulExit:false dict, not a bare <true/>",
  );
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>\s*<true\s*\/>/);
  // Still an auto-start service — the fix must not cost us "runs at login".
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\s*\/>/);
});

test("unitNeedsRefresh flags a pre-fix plist and clears once rewritten", () => {
  const old = join(DIR, "old.plist");
  writeFileSync(old, `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>Label</key><string>pro.privateer.harbor</string>
  <key>KeepAlive</key>
  <true/>
</dict></plist>
`);
  assert.equal(unitNeedsRefresh("darwin", old), true, "an installed always-restart plist wants rewriting");

  const fresh = join(DIR, "fresh.plist");
  writeFileSync(fresh, launchdPlist());
  assert.equal(unitNeedsRefresh("darwin", fresh), false, "what we generate today is current");

  // Narrow by design: a missing file isn't a refresh prompt, and Linux's unit
  // already carries the right policy (Restart=on-failure), so it is never flagged.
  assert.equal(unitNeedsRefresh("darwin", join(DIR, "nope.plist")), false);
  assert.equal(unitNeedsRefresh("linux", old), false);
});

// ── The unit that outlives the software it points at ────────────────────────────
//
// The unit bakes ABSOLUTE paths for the interpreter and the launcher. When the
// desktop app is what installed it, both live inside Privateer.app — so dragging the
// app to the Trash leaves a launchd job firing at every login against a binary that
// isn't there. Detecting that is what lets the desktop reap it (reapStaleService) and
// what lets `privateer harbor status` say so out loud.

function plistWith(args: string[], extra = ""): string {
  return `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>Label</key><string>pro.privateer.harbor</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
${extra}  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict></plist>
`;
}

test("unitProgramPaths reads the command back off both unit formats", () => {
  const mac = join(DIR, "args.plist");
  writeFileSync(mac, plistWith(["/Apps/P.app/Contents/MacOS/P", "/Apps/P.app/bin/harbor.mjs", "run"]));
  assert.deepEqual(unitProgramPaths("darwin", mac), [
    "/Apps/P.app/Contents/MacOS/P",
    "/Apps/P.app/bin/harbor.mjs",
    "run",
  ]);

  const linux = join(DIR, "harbor.service");
  writeFileSync(linux, "[Service]\nExecStart='/opt/it'\\''s/node' '/opt/harbor.mjs' 'run'\n");
  assert.deepEqual(unitProgramPaths("linux", linux), ["/opt/it's/node", "/opt/harbor.mjs", "run"]);

  // Unreadable or unrecognised is "can't tell", never a guess.
  assert.equal(unitProgramPaths("darwin", join(DIR, "nope.plist")), null);
  assert.equal(unitProgramPaths("win32", mac), null);
});

test("unitIsStale spots a unit left behind by a deleted app, and only that", () => {
  const gone = join(DIR, "gone.plist");
  writeFileSync(gone, plistWith(["/Applications/Privateer.app/Contents/MacOS/Privateer", "/Applications/Privateer.app/bin/harbor.mjs", "run"]));
  assert.equal(unitIsStale("darwin", gone), true, "both paths are missing — this unit can never start");

  const live = join(DIR, "live.plist");
  writeFileSync(live, launchdPlist());
  assert.equal(unitIsStale("darwin", live), false, "what we generate today points at things that exist");

  // A unit we can't parse must not be reported as stale — the sweep DELETES what this
  // flags, so the failure mode of a guess here is removing someone's working service.
  const opaque = join(DIR, "opaque.plist");
  writeFileSync(opaque, "<plist><dict><key>Label</key><string>x</string></dict></plist>");
  assert.equal(unitIsStale("darwin", opaque), false);
  assert.equal(unitIsStale("darwin", join(DIR, "missing.plist")), false);
});

test("unitNeedsRefresh flags an Electron unit with no ELECTRON_RUN_AS_NODE", () => {
  // The interpreter has to EXIST or the unit reads as stale instead — which is the
  // real-world shape of this bug: the app is still installed, the unit is just wrong.
  const app = join(DIR, "Privateer");
  const launcher = join(DIR, "harbor.mjs");
  writeFileSync(app, "");
  writeFileSync(launcher, "");

  const broken = join(DIR, "no-run-as-node.plist");
  writeFileSync(broken, plistWith([app, launcher, "run"]));
  assert.equal(unitNeedsRefresh("darwin", broken), true, "this unit starts the desktop APP at login, not a harbor");

  const fixed = join(DIR, "run-as-node.plist");
  writeFileSync(
    fixed,
    plistWith([app, launcher, "run"], "  <key>EnvironmentVariables</key>\n  <dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict>\n"),
  );
  assert.equal(unitNeedsRefresh("darwin", fixed), false);

  // A plain `node` interpreter is never an Electron binary, whatever else is in there.
  const plain = join(DIR, "plain.plist");
  writeFileSync(plain, plistWith([process.execPath, launcher, "run"]));
  assert.equal(unitNeedsRefresh("darwin", plain), false);

  // Stale beats needs-refresh: rewriting only re-bakes the same dead path.
  const stale = join(DIR, "stale.plist");
  writeFileSync(stale, plistWith([join(DIR, "vanished"), launcher, "run"]));
  assert.equal(unitNeedsRefresh("darwin", stale), false);
});
