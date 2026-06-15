import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchAttestation, teePosture } from "../src/providers/attestation.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Reply with a canned body and echo the request's nonce back into it (the real
// gateway binds report_data = signing_address || nonce), so freshness is testable.
function mockAttestation(body: (nonce: string) => unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    calls.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> });
    const nonce = new URL(u).searchParams.get("nonce") ?? "";
    const b = body(nonce);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      json: async () => b,
      text: async () => JSON.stringify(b),
    } as Response;
  }) as typeof fetch;
  return calls;
}

test("fetchAttestation sends the model, nonce, and bearer key to the report endpoint", async () => {
  const calls = mockAttestation((nonce) => ({
    signing_address: "0xabc123",
    nvidia_payload: "…",
    intel_tdx_quote: "…",
    nonce,
  }));
  const att = await fetchAttestation({ apiKey: "near-key" }, "zai-org/GLM-5.1-FP8");
  assert.match(calls[0].url, /cloud-api\.near\.ai\/v1\/attestation\/report/);
  assert.match(calls[0].url, /model=zai-org%2FGLM-5\.1-FP8/);
  assert.match(calls[0].url, /nonce=[0-9a-f]{64}/);
  assert.equal(calls[0].headers.authorization, "Bearer near-key");
  assert.equal(att.signingAddress, "0xabc123");
  assert.deepEqual(att.hardware, ["NVIDIA", "Intel TDX"]);
  assert.equal(att.nonceEchoed, true);
});

test("fetchAttestation requires a key", async () => {
  await assert.rejects(() => fetchAttestation({}, "m"), /no API key/);
});

test("fetchAttestation propagates a non-OK status", async () => {
  mockAttestation(() => ({ error: "nope" }), 403);
  await assert.rejects(() => fetchAttestation({ apiKey: "near-key" }, "m"), /403/);
});

test("teePosture: green when signed, hardware-backed, and nonce-fresh", () => {
  assert.equal(
    teePosture({
      model: "m",
      nonce: "n",
      signingAddress: "0xabc",
      nonceEchoed: true,
      hardware: ["NVIDIA", "Intel TDX"],
      raw: {},
    }),
    "green",
  );
});

test("teePosture: yellow when attested but the nonce wasn't echoed (freshness unconfirmed)", () => {
  assert.equal(
    teePosture({
      model: "m",
      nonce: "n",
      signingAddress: "0xabc",
      nonceEchoed: false,
      hardware: ["NVIDIA"],
      raw: {},
    }),
    "yellow",
  );
});

test("teePosture: red when no signing key and no hardware evidence", () => {
  assert.equal(
    teePosture({ model: "m", nonce: "n", nonceEchoed: false, hardware: [], raw: {} }),
    "red",
  );
});
