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
import { launchdPlist, unitNeedsRefresh } from "../src/harbor/service.ts";

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
