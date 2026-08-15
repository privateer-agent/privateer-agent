/**
 * The `extensions` frame's moat fields — the pair that keeps the app's Browse tab honest.
 *
 * The app browses an UNFILTERED npm `keywords:pi-package` search, so packages we already
 * ship sit in its catalog: pi-mcp-adapter, pi-subagents and the rpiv packs are on its
 * first page. Before these fields the app had no way to know that, so it drew an Add
 * button on each one — a button whose only possible outcome is extensionsControl.add()
 * refusing it, and which until then reads as "you don't have this", the opposite of the
 * truth. `builtIn` gives the app the list to show; `managed` gives it the list to stop
 * offering.
 *
 * The invariant worth pinning is the JOIN between the two halves, because they live in
 * different files and drift silently: every name the app is told not to offer must be a
 * name the terminal would in fact refuse, and everything we ship must be in that set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { makeExtensionsControl } from "../src/remote/extensionsControl.ts";
import { MOAT_SHIMS } from "../src/config/moatManifest.ts";

const HOME = mkdtempSync(join(tmpdir(), "priv-ext-frame-"));
process.env.PRIVATEER_HOME = HOME;

const { RelayClient } = await import("../src/remote/relayClient.ts");

test.after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// Capture what sendExtensions puts on the wire, with no relay behind it: rawSend only
// needs an OPEN-looking socket with a send().
function frameFor(installed: { source: string; scope: string }[]): any {
  const sent: string[] = [];
  const relay: any = new RelayClient({} as any, { termId: "t", label: "t" });
  relay.ws = { readyState: 1, send: (s: string) => sent.push(s) };
  relay.sendExtensions({ installed });
  relay.stop();
  assert.equal(sent.length, 1, "one extensions frame per call");
  return JSON.parse(sent[0]);
}

test("the extensions frame carries the moat the installed list omits", () => {
  const frame = frameFor([{ source: "npm:pi-hello", scope: "user" }]);

  assert.equal(frame.type, "extensions");
  assert.deepEqual(
    frame.installed.map((e: any) => e.source),
    ["npm:pi-hello"],
    "the user's own packages, unchanged",
  );

  // Everything we ship, in load order, each with the one-line note the app renders.
  assert.deepEqual(
    frame.builtIn.map((b: any) => b.name),
    MOAT_SHIMS.map((s) => s.name),
  );
  assert.ok(
    frame.builtIn.every((b: any) => typeof b.note === "string" && b.note.length > 0),
    "a built-in with no note lists as a bare name the user cannot place",
  );

  // The names the app must not offer to add. The specific ones below are the packages
  // that actually surface on the catalog's first page — the reason this exists.
  for (const name of ["pi-mcp-adapter", "pi-subagents", "@juicesharp/rpiv-web-tools", "pi-privacy"]) {
    assert.ok(frame.managed.includes(name), `${name} is in the npm catalog and must be marked managed`);
  }
});

test("every managed name is one the terminal would actually refuse", async () => {
  const frame = frameFor([]);
  const control = makeExtensionsControl({
    cwd: "/work",
    agentDir: "/work/.agent",
    settingsManager: SettingsManager.inMemory({ packages: [] }),
  });

  // The join: if the app suppresses Add for a name add() would have accepted, we have
  // hidden a package the user could legitimately install. add() rejects reserved names
  // before touching npm, so this stays offline.
  for (const name of frame.managed) {
    const res = await control.add(`npm:${name}`);
    assert.equal(res.ok, false, `${name} is marked managed but add() accepts it`);
    assert.match(res.message ?? "", /Privateer/);
  }
});

test("every built-in is managed — we never ship what the app would offer to install", () => {
  const frame = frameFor([]);
  for (const b of frame.builtIn) {
    assert.ok(frame.managed.includes(b.name), `${b.name} ships but is not reserved`);
  }
});
