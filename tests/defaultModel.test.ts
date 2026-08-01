// PRIVATEER_HOME must point somewhere disposable before the paths module resolves
// (globalDir reads it lazily). ensurePiDefaultModel writes agentDir/settings.json.
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-default-model-test";
// The runner's ambient env must not leak into defaults that read process.env
// (ensurePiDefaultModel's default seed is resolveSignedInModel(), which does).
delete process.env.TINFOIL_API_KEY;
delete process.env.PRIVATEER_MODEL;

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNT_DEFAULT_SPEC,
  LEGACY_BYO_FALLBACK,
  TINFOIL_DEFAULT_SPEC,
  TINFOIL_MODEL_ID,
  ensurePiDefaultModel,
  resolveDefaultModel,
  resolveSignedInModel,
  savedPiDefaultSpec,
} from "../src/providers/defaultModel.ts";
import { agentDir } from "../src/config/paths.ts";

function freshHome() {
  rmSync(process.env.PRIVATEER_HOME!, { recursive: true, force: true });
  mkdirSync(agentDir(), { recursive: true });
}

// A crashed earlier run could leave a settings.json behind, and resolveDefaultModel
// now reads it by default — start every run from a clean slate.
freshHome();

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

test("resolveDefaultModel: an OpenRouter key still gets the legacy default", () => {
  assert.equal(resolveDefaultModel({ env: { OPENROUTER_API_KEY: "or" }, signedIn: false }), LEGACY_BYO_FALLBACK);
});

test("resolveDefaultModel: signed out with NO key lands on the account channel, not OpenRouter", () => {
  // The dead-end fix: pinning a keyless terminal to OpenRouter made the first prompt
  // fail with "No API key found for openrouter", which /login neither explained nor
  // fixed. Pointing at the account model instead means signing in needs no model switch
  // and the error until then names Privateer.
  assert.equal(resolveDefaultModel({ env: {}, signedIn: false }), ACCOUNT_DEFAULT_SPEC);
  assert.notEqual(resolveDefaultModel({ env: {}, signedIn: false }), LEGACY_BYO_FALLBACK);
});

test("resolveDefaultModel: a Tinfoil key means direct (client-attested) Tinfoil", () => {
  // Signed in or not, a Tinfoil key reaches the same model without the server proxy —
  // and only that route can be attested client-side, so it wins.
  assert.equal(resolveDefaultModel({ env: { TINFOIL_API_KEY: "tk" }, signedIn: true }), TINFOIL_DEFAULT_SPEC);
  // And signed out it beats the OpenRouter fallback / other BYO keys.
  assert.equal(resolveDefaultModel({ env: { TINFOIL_API_KEY: "tk" }, signedIn: false }), TINFOIL_DEFAULT_SPEC);
  assert.equal(
    resolveDefaultModel({ env: { TINFOIL_API_KEY: "tk", OPENROUTER_API_KEY: "or" }, signedIn: false }),
    TINFOIL_DEFAULT_SPEC,
  );
  // PRIVATEER_MODEL still outranks it.
  assert.equal(
    resolveDefaultModel({ env: { TINFOIL_API_KEY: "tk", PRIVATEER_MODEL: "openai/gpt-5.5" }, signedIn: false }),
    "openai/gpt-5.5",
  );
});

test("the default is one Tinfoil model, however it's reached", () => {
  // Same model both ways — direct with a key, over the subscription without one.
  // Pinned to the literal on purpose: moving the default is a deliberate, measured
  // decision (see TINFOIL_MODEL_ID), not something a refactor should do quietly.
  assert.equal(TINFOIL_DEFAULT_SPEC, "tinfoil/kimi-k2-6");
  assert.equal(ACCOUNT_DEFAULT_SPEC, "privateer/tinfoil/kimi-k2-6");
});

test("resolveSignedInModel: Tinfoil when keyed, else the account channel", () => {
  assert.equal(resolveSignedInModel({ TINFOIL_API_KEY: "tk" }), TINFOIL_DEFAULT_SPEC);
  assert.equal(resolveSignedInModel({}), ACCOUNT_DEFAULT_SPEC);
});

test("resolveDefaultModel: a saved Pi default (the user's own pick) sticks", () => {
  freshHome();
  writeFileSync(
    join(agentDir(), "settings.json"),
    JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-8" }),
  );
  // The pick outranks key-inference and the signed-in default — this is what makes
  // a /models switch actually persist across launches.
  assert.equal(
    resolveDefaultModel({ env: { TINFOIL_API_KEY: "tk" }, signedIn: true }),
    "anthropic/claude-opus-4-8",
  );
  // …but never a deliberate override.
  assert.equal(resolveDefaultModel({ env: { PRIVATEER_MODEL: "x/y" }, signedIn: true }), "x/y");
  assert.equal(resolveDefaultModel({ explicit: "a/b", signedIn: true }), "a/b");
  // resolveSignedInModel is the sign-in TARGET and ignores the saved pick — the
  // stay-or-switch decision lives at its call sites.
  assert.equal(resolveSignedInModel({}), ACCOUNT_DEFAULT_SPEC);
});

test("savedPiDefaultSpec: needs both halves, tolerates absence", () => {
  freshHome();
  assert.equal(savedPiDefaultSpec(), null, "no settings.json → null");
  writeFileSync(join(agentDir(), "settings.json"), JSON.stringify({ defaultModel: "solo-id" }));
  assert.equal(savedPiDefaultSpec(), null, "model without provider → null");
  writeFileSync(
    join(agentDir(), "settings.json"),
    JSON.stringify({ defaultProvider: "privateer", defaultModel: "tinfoil/glm-5-2" }),
  );
  assert.equal(savedPiDefaultSpec(), "privateer/tinfoil/glm-5-2");
});

test("ensurePiDefaultModel: a Tinfoil key seeds the direct (client-attested) route", () => {
  freshHome();
  process.env.TINFOIL_API_KEY = "tk";
  try {
    assert.equal(ensurePiDefaultModel(), TINFOIL_DEFAULT_SPEC);
    const settings = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
    assert.equal(settings.defaultProvider, "tinfoil");
    assert.equal(settings.defaultModel, "kimi-k2-6");
  } finally {
    delete process.env.TINFOIL_API_KEY;
  }
});

test("ensurePiDefaultModel: seeds provider+model when settings.json has no default", () => {
  freshHome();
  const written = ensurePiDefaultModel();
  assert.equal(written, ACCOUNT_DEFAULT_SPEC);
  const settings = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "privateer");
  assert.equal(settings.defaultModel, TINFOIL_MODEL_ID);
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
