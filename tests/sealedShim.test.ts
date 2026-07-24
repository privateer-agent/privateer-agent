import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildForward,
  sealedProviderFor,
  sealedEnabled,
  relayBase,
} from "../src/providers/sealedShim.ts";

// ── model → sealed provider classification ────────────────────────────────────

test("sealedProviderFor classifies tinfoil, not others", () => {
  assert.equal(sealedProviderFor("tinfoil/glm-5-2"), "tinfoil");
  assert.equal(sealedProviderFor("near/deepseek-v4"), null); // NEAR: attested-TLS, not sealed
  assert.equal(sealedProviderFor("phala/whatever"), null); // no Node client yet
  assert.equal(sealedProviderFor("anthropic/claude-sonnet-4.6"), null);
  assert.equal(sealedProviderFor("openai/gpt-5.5"), null);
});

// ── feature flag ──────────────────────────────────────────────────────────────

test("sealedEnabled reads PRIVATEER_SEALED", () => {
  const prev = process.env.PRIVATEER_SEALED;
  try {
    delete process.env.PRIVATEER_SEALED;
    assert.equal(sealedEnabled(), false);
    process.env.PRIVATEER_SEALED = "1";
    assert.equal(sealedEnabled(), true);
    process.env.PRIVATEER_SEALED = "true";
    assert.equal(sealedEnabled(), true);
    process.env.PRIVATEER_SEALED = "0";
    assert.equal(sealedEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_SEALED;
    else process.env.PRIVATEER_SEALED = prev;
  }
});

// ── request shaping (the byte-level contract with the relay) ──────────────────

test("buildForward strips the provider prefix from the body model", () => {
  const plan = buildForward(
    "tinfoil",
    JSON.stringify({ model: "tinfoil/glm-5-2", messages: [{ role: "user", content: "hi" }], stream: true }),
    "Bearer abc.def",
  );
  const body = JSON.parse(plan.body);
  // The enclave wants the bare id; the body is encrypted so the relay can't strip it.
  assert.equal(body.model, "glm-5-2");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.equal(body.stream, true);
});

test("buildForward keeps the FULL prefixed id on the cleartext billing header", () => {
  const plan = buildForward("tinfoil", JSON.stringify({ model: "tinfoil/glm-5-2", messages: [] }), undefined);
  // The relay prices billing off X-Sealed-Model (it never reads the sealed body),
  // and its pricing table is keyed by the prefixed id.
  assert.equal(plan.headers["X-Sealed-Model"], "tinfoil/glm-5-2");
  assert.equal(plan.sealedModel, "tinfoil/glm-5-2");
  assert.equal(plan.headers["Content-Type"], "application/json");
});

test("buildForward forwards the account bearer, and omits it when absent", () => {
  const withAuth = buildForward("tinfoil", JSON.stringify({ model: "tinfoil/x" }), "Bearer tok123");
  assert.equal(withAuth.headers.Authorization, "Bearer tok123");
  const noAuth = buildForward("tinfoil", JSON.stringify({ model: "tinfoil/x" }), undefined);
  assert.equal("Authorization" in noAuth.headers, false);
});

test("buildForward targets the provider's blind-relay endpoint", () => {
  const plan = buildForward("tinfoil", JSON.stringify({ model: "tinfoil/x" }), undefined);
  assert.equal(plan.url, `${relayBase("tinfoil")}/v1/chat/completions`);
  assert.match(plan.url, /\/api\/sealed\/tinfoil\/v1\/chat\/completions$/);
});

test("buildForward passes non-JSON bodies through unchanged with unknown model", () => {
  const plan = buildForward("tinfoil", "not json at all", "Bearer t");
  assert.equal(plan.body, "not json at all");
  assert.equal(plan.headers["X-Sealed-Model"], "unknown");
});

test("buildForward leaves an already-bare model id alone", () => {
  const plan = buildForward("tinfoil", JSON.stringify({ model: "glm-5-2" }), undefined);
  assert.equal(JSON.parse(plan.body).model, "glm-5-2");
  assert.equal(plan.headers["X-Sealed-Model"], "glm-5-2");
});
