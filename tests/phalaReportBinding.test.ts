// verifyReportBinding — the crypto binding that establishes the Phala workload
// keyset (§9.1 checks 2–3). See src/providers/phala/aci-verifier/report.ts.
//
// Under aci/1 there is no keyset endorsement to check: the served keyset
// canonicalizes to a digest, that digest plus our nonce make the attestation
// statement, and sha256 of the statement is the `report_data` the TDX quote
// signs (phalaSeal.ts verifies the quote itself). So this one recomputation is
// what stops a relay swapping the X25519 key we seal our prompts to.
//
// The fixture is a REAL attestation report fetched from
// ${server}/api/sealed/phala/attestation on 2026-08-24 with NONCE below, trimmed
// to the fields the binding checks read (the TDX quote and the event log belong
// to the hardware layer — phalaSeal.ts and measurements.ts).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  verifyReportBinding,
  computeKeysetDigest,
  AciFormatError,
  type AttestationReport,
  type Check,
} from "../src/providers/phala/aci-verifier/index.ts";

const REPORT: AttestationReport = JSON.parse(
  readFileSync(new URL("./fixtures/phala-report-aci1.json", import.meta.url), "utf8"),
);

// The nonce the fixture was issued for. report_data binds to it, so it is as much
// of the fixture as the JSON is.
const NONCE = "2ad0e49a3bbdaa1e91bc22464c29d447424d2511d020e83707b3457a77b0e85a";

// Pinned so the expiry check stays deterministic — the fixture's keyset expires
// (not_after 1789869673 = 2026-09-20) and a wall-clock test would rot.
const NOW = 1787537180; // when the fixture was fetched

const clone = (): AttestationReport => JSON.parse(JSON.stringify(REPORT)) as AttestationReport;
const named = (checks: Check[], name: string) => checks.find((c) => c.name === name);

test("verifies the live gateway's aci/1 report for the nonce it was issued for", async () => {
  const res = await verifyReportBinding(REPORT, NONCE, { now: NOW });
  assert.equal(res.ok, true, `failed: ${res.checks.filter((c) => !c.ok).map((c) => c.detail)}`);
  assert.deepEqual(
    res.checks.map((c) => c.name),
    ["api_version", "workload_keyset_digest", "report_data", "not_after"],
  );
  assert.equal(res.workloadKeysetDigest, REPORT.workload_keyset_digest);
  // The established keyset is what callers seal to — it must come back parsed.
  assert.ok(res.keyset?.e2ee_public_keys.some((k) => k.algo === "x25519-aes-256-gcm-hkdf-sha256"));
});

test("binds the nonce: report_data fails under a nonce it wasn't issued for", async () => {
  const other = NONCE.slice(0, 63) + (NONCE.endsWith("a") ? "b" : "a");
  const res = await verifyReportBinding(REPORT, other, { now: NOW });
  assert.equal(res.ok, false);
  assert.equal(named(res.checks, "report_data")?.ok, false);
});

test("a no-nonce statement does not satisfy a nonced report", async () => {
  const res = await verifyReportBinding(REPORT, null, { now: NOW });
  assert.equal(named(res.checks, "report_data")?.ok, false);
});

test("swapping the attested E2EE key breaks the binding — the whole point", async () => {
  const r = clone();
  const keys = (
    r.attestation.workload_keyset as { e2ee_public_keys: { algo: string; public_key: string }[] }
  ).e2ee_public_keys;
  const key = keys.find((k) => k.algo === "x25519-aes-256-gcm-hkdf-sha256")!;
  key.public_key = key.public_key.slice(0, -1) + (key.public_key.endsWith("0") ? "1" : "0");

  const res = await verifyReportBinding(r, NONCE, { now: NOW });
  assert.equal(res.ok, false);
  // Both: the keyset no longer digests to what the report restates, and the
  // recomputed digest no longer produces the report_data the quote signed.
  assert.equal(named(res.checks, "workload_keyset_digest")?.ok, false);
  assert.equal(named(res.checks, "report_data")?.ok, false);
});

test("the recomputed digest is authoritative, not the report's restated copy", async () => {
  const r = clone();
  r.workload_keyset_digest = "sha256:" + "0".repeat(64);
  const res = await verifyReportBinding(r, NONCE, { now: NOW });
  assert.equal(named(res.checks, "workload_keyset_digest")?.ok, false);
  // report_data still passes: the statement was built from the keyset's own bytes.
  assert.equal(named(res.checks, "report_data")?.ok, true);
});

test("an expired keyset fails", async () => {
  const keyset = REPORT.attestation.workload_keyset as { not_after: number };
  const res = await verifyReportBinding(REPORT, NONCE, { now: keyset.not_after + 1 });
  assert.equal(res.ok, false);
  assert.equal(named(res.checks, "not_after")?.ok, false);
});

test("a foreign api_version is refused", async () => {
  const r = clone();
  r.api_version = "aci/2";
  const res = await verifyReportBinding(r, NONCE, { now: NOW });
  assert.equal(res.ok, false);
  assert.equal(named(res.checks, "api_version")?.ok, false);
});

test("a keyset that is not an object fails every downstream check, without throwing", async () => {
  const r = clone();
  (r.attestation as { workload_keyset: unknown }).workload_keyset = "not-an-object";
  const res = await verifyReportBinding(r, NONCE, { now: NOW });
  assert.equal(res.ok, false);
  assert.deepEqual(
    res.checks.map((c) => c.name),
    ["api_version", "workload_keyset_digest", "report_data", "not_after"],
  );
  assert.equal(res.keyset, undefined);
});

test("a malformed nonce is the caller's bug and throws", async () => {
  // Server-supplied fields are reported as failed checks; our own input is not.
  await assert.rejects(() => verifyReportBinding(REPORT, "deadbeef", { now: NOW }), AciFormatError);
});

test("the keyset digest is over the served object, unknown members included", async () => {
  // Appendix A canonicalizes what was parsed — an extension field the client does
  // not understand still changes the digest, so it cannot be smuggled in.
  const keyset = JSON.parse(JSON.stringify(REPORT.attestation.workload_keyset)) as Record<string, unknown>;
  assert.equal(await computeKeysetDigest(keyset), REPORT.workload_keyset_digest);
  keyset.some_future_field = "x";
  assert.notEqual(await computeKeysetDigest(keyset), REPORT.workload_keyset_digest);
});
