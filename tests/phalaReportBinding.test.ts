// verifyAciReportBinding — the algorithm dispatch that lets us attest the deployed
// Phala gateway (ecdsa-secp256k1 keyset endorsement) without patching the vendored
// upstream verifier. See src/providers/phala/reportBinding.ts.
//
// The fixture is a REAL attestation report fetched from
// ${server}/api/sealed/phala/attestation on 2026-07-31, trimmed to the fields the
// binding checks read (the TDX quote belongs to the hardware layer, phalaSeal.ts).
// It was fetched WITHOUT a nonce, so report_data is the no-nonce statement digest.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { verifyAciReportBinding } from "../src/providers/phala/reportBinding.ts";
import {
  verifyReportBinding,
  UnsupportedAlgorithmError,
  toHex,
  fromHex,
  type AttestationReport,
} from "../src/providers/phala/aci-verifier/index.ts";

const REPORT: AttestationReport = JSON.parse(
  readFileSync(new URL("./fixtures/phala-report-secp256k1.json", import.meta.url), "utf8"),
);

// Pinned so the keyset_epoch/freshness checks stay deterministic — the fixture's
// keyset expires (not_after 1786181275) and a wall-clock test would rot.
const NOW = 1785483500; // inside the fixture's [fetched_at, stale_after) window

const clone = (): AttestationReport => JSON.parse(JSON.stringify(REPORT)) as AttestationReport;

test("verifies the live gateway's secp256k1 keyset endorsement (the case upstream refuses)", async () => {
  // Baseline: the vendored verifier cannot do this report at all.
  await assert.rejects(
    () => verifyReportBinding(REPORT, null, { now: NOW }),
    UnsupportedAlgorithmError,
    "fixture should be the algorithm upstream rejects — otherwise this test proves nothing",
  );

  const res = await verifyAciReportBinding(REPORT, null, { now: NOW, trustPlatformClock: true });
  assert.equal(res.ok, true, `failed: ${res.checks.filter((c) => !c.ok).map((c) => c.name)}`);
  assert.deepEqual(
    res.checks.map((c) => c.name),
    ["workload_id", "workload_keyset_digest", "report_data", "keyset_endorsement", "keyset_epoch.not_after", "freshness_window"],
  );
  assert.equal(res.workloadKeysetDigest, REPORT.workload_keyset_digest);
});

test("a tampered endorsement signature fails the check — it does not throw", async () => {
  const r = clone();
  const sig = fromHex(r.attestation.keyset_endorsement.value);
  sig[10] ^= 0xff;
  r.attestation.keyset_endorsement.value = toHex(sig);

  const res = await verifyAciReportBinding(r, null, { now: NOW });
  assert.equal(res.ok, false);
  const check = res.checks.find((c) => c.name === "keyset_endorsement");
  assert.equal(check?.ok, false);
});

test("accepts a high-s signature (malleability is meaningless over a fixed payload)", async () => {
  // (r, n-s) is an equally valid ECDSA signature. A signer that doesn't normalize
  // would otherwise fail attestation about half the time, intermittently.
  const raw = fromHex(REPORT.attestation.keyset_endorsement.value);
  const s = BigInt("0x" + toHex(raw.slice(32)));
  const flipped = secp256k1.CURVE.n - s;
  const hex = flipped.toString(16).padStart(64, "0");
  const r = clone();
  r.attestation.keyset_endorsement.value = toHex(raw.slice(0, 32)) + hex;

  const res = await verifyAciReportBinding(r, null, { now: NOW });
  assert.equal(res.checks.find((c) => c.name === "keyset_endorsement")?.ok, true);
});

test("a signature of the wrong shape is rejected, not thrown", async () => {
  for (const bad of ["", "abcd", REPORT.attestation.keyset_endorsement.value + "00"]) {
    const r = clone();
    r.attestation.keyset_endorsement.value = bad;
    const res = await verifyAciReportBinding(r, null, { now: NOW });
    assert.equal(res.checks.find((c) => c.name === "keyset_endorsement")?.ok, false, `shape ${bad.length}`);
  }
});

test("binds the nonce: the report_data check fails under a nonce it wasn't issued for", async () => {
  const res = await verifyAciReportBinding(REPORT, "deadbeef", { now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.checks.find((c) => c.name === "report_data")?.ok, false);
});

test("an endorsement algo that disagrees with the identity key fails", async () => {
  const r = clone();
  r.attestation.keyset_endorsement.algo = "ed25519";
  const res = await verifyAciReportBinding(r, null, { now: NOW });
  assert.equal(res.checks.find((c) => c.name === "keyset_endorsement")?.ok, false);
});

test("an expired keyset epoch fails", async () => {
  const res = await verifyAciReportBinding(REPORT, null, {
    now: REPORT.attestation.workload_keyset.keyset_epoch.not_after + 1,
  });
  assert.equal(res.ok, false);
  assert.equal(res.checks.find((c) => c.name === "keyset_epoch.not_after")?.ok, false);
});

test("ed25519 reports are delegated to the vendored verifier, byte for byte", async () => {
  // Drift guard: whatever upstream does for ed25519, we must return exactly that —
  // including future checks we never learn about. The report need not be valid;
  // identical failure output proves the delegation.
  const r = clone();
  r.attestation.workload_keyset.workload_identity.public_key.algo = "ed25519";
  r.attestation.keyset_endorsement.algo = "ed25519";

  const ours = await verifyAciReportBinding(r, null, { now: NOW, trustPlatformClock: true });
  const upstream = await verifyReportBinding(r, null, { now: NOW, trustPlatformClock: true });
  assert.deepEqual(ours, upstream);
});

test("an algorithm neither path can check still throws — never a silent pass", async () => {
  const r = clone();
  r.attestation.workload_keyset.workload_identity.public_key.algo = "rsa-pss-sha256";
  await assert.rejects(() => verifyAciReportBinding(r, null, { now: NOW }), UnsupportedAlgorithmError);
});
