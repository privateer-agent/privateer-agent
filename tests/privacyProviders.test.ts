// Disposable home: loading the privacy extension re-asserts the account provider, which
// reads (and the background catalog fetch would write) the cached-ids file.
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-privacy-providers-test";
process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import privateerPrivacy from "../extensions/privateer-privacy.ts";
import { ACCOUNT_DEFAULT_MODEL_ID } from "../src/providers/defaultModel.ts";

rmSync(process.env.PRIVATEER_HOME!, { recursive: true, force: true });

interface Registration {
  name: string;
  config: { name?: string; baseUrl?: string; apiKey?: string; models?: { id: string }[] };
}

// The subset of Pi's extension API pi-privacy feature-detects. Everything is a no-op
// sink except registerProvider, which is what this file is about.
function fakePi() {
  const registrations: Registration[] = [];
  return {
    registrations,
    // The LAST registration for a provider is the one the model registry ends up with:
    // Pi's applyProviderConfig fully replaces a provider's models and request config.
    last: (name: string) => [...registrations].reverse().find((r) => r.name === name)?.config,
    pi: {
      registerProvider: (name: string, config: unknown) =>
        registrations.push({ name, config: config as Registration["config"] }),
      registerCommand: () => {},
      setModel: () => true,
      on: () => {},
    },
  };
}

// Regression: pi-privacy's own PRIVACY_PROVIDERS catalog contains a `privateer` entry —
// the PUBLIC developer-key channel (api.privateer.pro/v1 + ${PRIVATEER_API_KEY}) with a
// single seed model. Pi's registerProvider REPLACES a provider's model list and request
// config, so that registration wiped the account channel's catalog that
// privateer-account had already registered. Two things broke at once: our default model
// stopped resolving ('Model "tinfoil/glm-5-2" not found for provider "privateer". Using
// custom model id.') and the model Pi synthesized in its place inherited the public
// baseUrl instead of the subscription's /api/agent/v1. The privacy extension now
// re-asserts the account registration after pi-privacy runs.
test("the privacy extension leaves the ACCOUNT channel registered as privateer", () => {
  const { pi, last, registrations } = fakePi();
  privateerPrivacy(pi);

  assert.ok(
    registrations.some(
      (r) => r.name === "privateer" && r.config.baseUrl === "https://api.privateer.pro/v1",
    ),
    "pi-privacy still registers its public developer-key channel — this test is only meaningful while it does",
  );

  const privateer = last("privateer");
  assert.ok(privateer, "privateer must be registered");
  assert.equal(privateer.baseUrl, "https://stub.privateer.test/api/agent/v1", "the account channel wins");
  assert.equal(privateer.apiKey, undefined, "the account channel authenticates by OAuth session, not a BYO key");

  const ids = (privateer.models ?? []).map((m) => m.id);
  assert.equal(ids[0], ACCOUNT_DEFAULT_MODEL_ID, "Pi clones models[0] for a custom id — the default must stay first");
  assert.ok(ids.length > 1, "the whole seed catalog survives, not just one model");
});

// Same failure mode, the case privateer-privacy already handled: pi-privacy seeds
// `tinfoil` with one model, so tinfoil/glm-5-2 (our default over a BYO Tinfoil key)
// would resolve as a custom model id.
test("the privacy extension widens the tinfoil catalog past pi-privacy's seed", () => {
  const { pi, last } = fakePi();
  privateerPrivacy(pi);

  const tinfoil = last("tinfoil");
  assert.ok(tinfoil, "tinfoil must be registered");
  const ids = (tinfoil.models ?? []).map((m) => m.id);
  assert.ok(ids.includes("glm-5-2"), "the launcher default must resolve");
  assert.ok(ids.length > 1, "more than pi-privacy's single seed model");
});
