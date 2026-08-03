import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The working-line tips extension (extensions/privateer-hints.ts). The rotation
// itself is a timer over ctx.ui.setWorkingMessage and not worth clocking in a unit
// test; what CAN silently break is the /hints toggle's persistence contract:
// default-on with no config, an explicit off survives in ~/.privateer/config.json,
// and the read-modify-write must not eat unrelated config keys (config.json also
// holds webhooks/remote/posture prefs). PRIVATEER_HOME is read at call time by
// src/config/paths.ts, so pointing it at a temp dir isolates the whole test.

const home = mkdtempSync(join(tmpdir(), "privateer-hints-"));
process.env.PRIVATEER_HOME = home;

const { default: privateerHints } = await import("../extensions/privateer-hints.ts");

// Minimal pi: capture the registered /hints handler; events are irrelevant here.
function load(): (args: string, ctx: any) => void {
  let handler: any;
  privateerHints({
    on: () => {},
    registerCommand: (name: string, def: any) => {
      if (name === "hints") handler = def.handler;
    },
  });
  assert.ok(handler, "the extension no longer registers /hints");
  return handler;
}

function notifyCollector(): { ctx: any; messages: string[] } {
  const messages: string[] = [];
  return { ctx: { ui: { notify: (m: string) => messages.push(m) } }, messages };
}

test("default is on: no config file, no hints block", () => {
  const hints = load();
  const { ctx, messages } = notifyCollector();
  hints("", ctx);
  assert.match(messages[0], /tips are on/);
});

test("/hints off persists and /hints reports it", () => {
  const hints = load();
  const { ctx, messages } = notifyCollector();
  hints("off", ctx);
  assert.match(messages[0], /tips off/);

  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(cfg.hints.enabled, false);

  hints("", ctx);
  assert.match(messages[1], /tips are off/);
});

test("toggling preserves unrelated config keys", () => {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ webhooks: { slack: "https://example.invalid" }, hints: { enabled: false } }),
  );
  const hints = load();
  const { ctx } = notifyCollector();
  hints("on", ctx);

  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  assert.equal(cfg.hints.enabled, true);
  assert.equal(cfg.webhooks.slack, "https://example.invalid"); // read-modify-write, not replace

  rmSync(home, { recursive: true, force: true });
});
