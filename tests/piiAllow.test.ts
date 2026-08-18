// The operator's PII allowlist: the answer to "the gate masked something that isn't
// personal data". Covers the file contract (where entries live, what survives a bad
// file), the edit API behind `/privacy allow`, and the freshness the live wiring needs —
// pi-privacy calls piiAllowEntries() once per matched value, so it is cached, and a cache
// that outlived our own write would make `/privacy allow` look like it did nothing.
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-pii-allow-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { addPiiAllow, piiAllowEntries, removePiiAllow } from "../src/config/piiAllow.ts";
import { configPath } from "../src/config/paths.ts";

const HOME = process.env.PRIVATEER_HOME!;
function reset(config?: unknown): void {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  if (config !== undefined) writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

test("no config, no entries — and a missing file is not an error", () => {
  reset();
  assert.deepEqual([...piiAllowEntries()], []);
});

test("entries come from privacy.piiAllow", () => {
  reset({ privacy: { piiAllow: ["@acme.com", "10.0.0.0/8"] } });
  assert.deepEqual([...piiAllowEntries()], ["@acme.com", "10.0.0.0/8"]);
});

test("a malformed file means NO entries, never a crash", () => {
  reset();
  writeFileSync(configPath(), "{ not json");
  assert.deepEqual([...piiAllowEntries()], [], "a config typo must not take the gate down");

  reset({ privacy: { piiAllow: "@acme.com" } }); // a string, not a list
  assert.deepEqual([...piiAllowEntries()], []);

  reset({ privacy: { piiAllow: ["@acme.com", 42, "", "  "] } });
  assert.deepEqual([...piiAllowEntries()], ["@acme.com"], "junk entries are dropped, the good one stays");
});

test("adding is immediate, idempotent, and keeps the rest of config.json", () => {
  reset({ webhooks: { deploy: "https://example.com/hook" } });

  const added = addPiiAllow("  @acme.com  ");
  assert.equal(added.ok, true);
  assert.deepEqual([...piiAllowEntries()], ["@acme.com"], "trimmed, and visible with no wait");

  const again = addPiiAllow("@acme.com");
  assert.equal(again.ok, true);
  assert.match(again.message, /already/);
  assert.deepEqual([...piiAllowEntries()], ["@acme.com"], "not duplicated");

  const cfg = JSON.parse(readFileSync(configPath(), "utf8"));
  assert.deepEqual(cfg.webhooks, { deploy: "https://example.com/hook" }, "other config survives the edit");
});

test("a bare * is refused — that is the gate off, wearing a different hat", () => {
  reset();
  const r = addPiiAllow("*");
  assert.equal(r.ok, false);
  assert.match(r.message, /everything/);
  assert.deepEqual([...piiAllowEntries()], []);
});

test("removing takes effect immediately; removing what isn't there says so", () => {
  reset({ privacy: { piiAllow: ["@acme.com", "10.0.0.0/8"] } });

  const gone = removePiiAllow("@acme.com");
  assert.equal(gone.ok, true);
  assert.deepEqual([...piiAllowEntries()], ["10.0.0.0/8"]);

  const missing = removePiiAllow("@nobody.com");
  assert.equal(missing.ok, false);
  assert.deepEqual([...piiAllowEntries()], ["10.0.0.0/8"], "a failed remove changes nothing");
});

rmSync(HOME, { recursive: true, force: true });
