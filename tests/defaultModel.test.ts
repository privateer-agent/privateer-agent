// PRIVATEER_HOME must point somewhere disposable before the paths module resolves
// (globalDir reads it lazily). ensurePiDefaultModel writes agentDir/settings.json.
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-default-model-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNT_DEFAULT_SPEC,
  LEGACY_BYO_FALLBACK,
  ensurePiDefaultModel,
  resolveDefaultModel,
} from "../src/providers/defaultModel.ts";
import { agentDir } from "../src/config/paths.ts";

function freshHome() {
  rmSync(process.env.PRIVATEER_HOME!, { recursive: true, force: true });
  mkdirSync(agentDir(), { recursive: true });
}

test("resolveDefaultModel: an explicit choice wins over everything", () => {
  assert.equal(
    resolveDefaultModel({ explicit: "anthropic/claude-opus-4-8", env: { PRIVATEER_MODEL: "x/y" }, signedIn: true }),
    "anthropic/claude-opus-4-8",
  );
  // Blank/whitespace explicit is ignored, not treated as a choice.
  assert.equal(resolveDefaultModel({ explicit: "   ", signedIn: true }), ACCOUNT_DEFAULT_SPEC);
});

test("resolveDefaultModel: PRIVATEER_MODEL env beats the account default", () => {
  assert.equal(resolveDefaultModel({ env: { PRIVATEER_MODEL: "openai/gpt-5.5" }, signedIn: true }), "openai/gpt-5.5");
});

test("resolveDefaultModel: signed in → the account default (the fix)", () => {
  assert.equal(resolveDefaultModel({ env: {}, signedIn: true }), ACCOUNT_DEFAULT_SPEC);
});

test("resolveDefaultModel: signed out prefers a BYO key, in order", () => {
  assert.equal(resolveDefaultModel({ env: { ANTHROPIC_API_KEY: "sk-a" }, signedIn: false }), "anthropic/claude-opus-4-8");
  assert.equal(resolveDefaultModel({ env: { OPENAI_API_KEY: "sk-o" }, signedIn: false }), "openai/gpt-5.5");
  // anthropic outranks openai when both are present.
  assert.equal(
    resolveDefaultModel({ env: { OPENAI_API_KEY: "sk-o", ANTHROPIC_API_KEY: "sk-a" }, signedIn: false }),
    "anthropic/claude-opus-4-8",
  );
});

test("resolveDefaultModel: signed out with no key falls back to the legacy default", () => {
  assert.equal(resolveDefaultModel({ env: {}, signedIn: false }), LEGACY_BYO_FALLBACK);
});

test("ensurePiDefaultModel: seeds provider+model when settings.json has no default", () => {
  freshHome();
  const written = ensurePiDefaultModel();
  assert.equal(written, ACCOUNT_DEFAULT_SPEC);
  const settings = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "privateer");
  assert.equal(settings.defaultModel, "near/zai-org/GLM-5.1-FP8");
});

test("ensurePiDefaultModel: never stomps an existing user default", () => {
  freshHome();
  writeFileSync(
    join(agentDir(), "settings.json"),
    JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-8", theme: "dark" }),
  );
  const written = ensurePiDefaultModel();
  assert.equal(written, null);
  const settings = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "anthropic");
  assert.equal(settings.defaultModel, "claude-opus-4-8");
  assert.equal(settings.theme, "dark", "unrelated settings must be preserved");
});

test("ensurePiDefaultModel: preserves unrelated keys when it does seed", () => {
  freshHome();
  writeFileSync(join(agentDir(), "settings.json"), JSON.stringify({ theme: "dark" }));
  ensurePiDefaultModel();
  const settings = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
  assert.equal(settings.theme, "dark");
  assert.equal(settings.defaultProvider, "privateer");
});

test("ensurePiDefaultModel: a spec with no provider prefix is a no-op", () => {
  freshHome();
  assert.equal(ensurePiDefaultModel("bareword"), null);
  assert.ok(!existsSync(join(agentDir(), "settings.json")), "must not create a file for an invalid spec");
});

test.after(() => rmSync(process.env.PRIVATEER_HOME!, { recursive: true, force: true }));
