import { test } from "node:test";
import assert from "node:assert/strict";
import { browsableUrl, canOpenBrowser } from "../src/util/openBrowser.ts";

// canOpenBrowser decides the /login widget's WORDING before any spawn happens, so
// its judgment calls are contract: a wrong "true" tells the user a browser opened
// when none could ("check the code in your browser" with no browser), and a wrong
// "false" downgrades every desktop login to the copy-the-link flow.

test("canOpenBrowser: plain desktop sessions may open", () => {
  assert.equal(canOpenBrowser({}, "darwin"), true);
  assert.equal(canOpenBrowser({}, "win32"), true);
  assert.equal(canOpenBrowser({ DISPLAY: ":0" }, "linux"), true);
  assert.equal(canOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
});

test("canOpenBrowser: SSH sessions never open (browser would land on the far machine)", () => {
  assert.equal(canOpenBrowser({ SSH_TTY: "/dev/pts/1", DISPLAY: ":0" }, "linux"), false);
  assert.equal(canOpenBrowser({ SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" }, "darwin"), false);
});

test("canOpenBrowser: display-less linux is headless", () => {
  assert.equal(canOpenBrowser({}, "linux"), false);
});

test("canOpenBrowser: PRIVATEER_NO_BROWSER is an absolute opt-out", () => {
  assert.equal(canOpenBrowser({ PRIVATEER_NO_BROWSER: "1", DISPLAY: ":0" }, "linux"), false);
  assert.equal(canOpenBrowser({ PRIVATEER_NO_BROWSER: "1" }, "darwin"), false);
  // …but a blank value is not a set value.
  assert.equal(canOpenBrowser({ PRIVATEER_NO_BROWSER: "  " }, "darwin"), true);
});

// browsableUrl is the gate between a server-supplied string and an OS launcher —
// it must pass real verification links through untouched and refuse everything
// that isn't plain http(s), rather than "helpfully" repairing it (that's
// verificationLink's job, upstream, for DISPLAY only).

test("browsableUrl: passes well-formed http(s) links through", () => {
  const u = "https://privateer.pro/settings/link-terminal?code=WXYZ-2345";
  assert.equal(browsableUrl(u), u);
  assert.equal(browsableUrl("http://localhost:8081/settings/link-terminal"), "http://localhost:8081/settings/link-terminal");
});

test("browsableUrl: refuses non-http schemes and malformed values", () => {
  assert.equal(browsableUrl("file:///etc/passwd"), undefined);
  assert.equal(browsableUrl("privateer://link"), undefined);
  assert.equal(browsableUrl("javascript:alert(1)"), undefined);
  assert.equal(browsableUrl("www.privateer.pro/settings/link-terminal"), undefined); // scheme-less: display-only
  assert.equal(browsableUrl(""), undefined);
  assert.equal(browsableUrl(undefined), undefined);
  assert.equal(browsableUrl("   "), undefined);
});
