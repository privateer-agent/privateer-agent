// Algorithm dispatch for the ACI report-binding checks (§10.1 checks 2–6).
//
// The ACI spec (§4.3) allows the keyset endorsement to be signed with EITHER
// `ed25519` OR `ecdsa-secp256k1` — the former because "every primitive in it is
// available in the Web Crypto API", the latter for "clients in the EVM/dstack
// ecosystem". Upstream's reference TS verifier implements only the Web Crypto half:
// `verifySignature` throws `UnsupportedAlgorithmError` on secp256k1
// (aci-verifier/crypto.ts), and `verifyReportBinding` propagates that.
//
// The deployed gateway (inference.phala.com) signs with `ecdsa-secp256k1`, so the
// vendored verifier can never attest it — a limit of upstream's CLIENT, not of the
// spec or the gateway. Verified live 2026-07-31: attestation fetched, endorsement
// rejected with UnsupportedAlgorithmError.
//
// This module owns the dispatch so `aci-verifier/` stays byte-for-byte upstream
// (see its VENDORED.md — only the `.js`-extension strip diverges, and re-pulls stay
// mechanical):
//   ed25519         → delegate to the vendored verifyReportBinding, verbatim
//   ecdsa-secp256k1 → the same checks 2–6, with check 5 done over @noble/curves
//   anything else   → still throws (never a silent pass)
//
// The secp256k1 path deliberately mirrors report.ts check-for-check, in the same
// order and with the same check names, so a caller cannot tell which path ran.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  verifyReportBinding,
  computeWorkloadId,
  computeKeysetDigest,
  computeReportData,
  keysetEndorsementPayload,
  sha256,
  fromHex,
  UnsupportedAlgorithmError,
  type AttestationReport,
  type Check,
  type ReportVerification,
  type ReportBindingOptions,
} from "./aci-verifier/index.ts";

const ED25519 = "ed25519";
const SECP256K1 = "ecdsa-secp256k1";

/**
 * Verify a report's cryptographic bindings for `nonce` (§10.1 checks 2–6),
 * dispatching on the algorithm the attested identity key declares. Drop-in
 * replacement for the vendored `verifyReportBinding`: same arguments, same result
 * shape, same "a failed check is `ok: false`, never thrown" contract.
 *
 * Like upstream, this is the crypto-binding half only — compose it with a hardware
 * quote verifier (phalaSeal.ts `verifyHardwareQuote`) for Level 2.
 */
export async function verifyAciReportBinding(
  report: AttestationReport,
  nonce: string | null | undefined,
  options: ReportBindingOptions = {},
): Promise<ReportVerification> {
  const algo = report.attestation.workload_keyset.workload_identity.public_key.algo;
  if (algo === ED25519) return verifyReportBinding(report, nonce, options);
  if (algo !== SECP256K1) {
    // Same fail-closed posture as upstream: an algorithm we cannot check is a
    // refusal, not a pass.
    throw new UnsupportedAlgorithmError(algo, "keyset endorsement (§4.3)");
  }
  return verifySecp256k1ReportBinding(report, nonce, options);
}

async function verifySecp256k1ReportBinding(
  report: AttestationReport,
  nonce: string | null | undefined,
  options: ReportBindingOptions,
): Promise<ReportVerification> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const checks: Check[] = [];

  const keyset = report.attestation.workload_keyset;
  const identityKey = keyset.workload_identity.public_key;

  // Check 2: workload_id == digest of the identity public key in the report's keyset.
  const workloadId = await computeWorkloadId(identityKey);
  pushEqual(checks, "workload_id", report.workload_id, workloadId);

  // Check 3: workload_keyset_digest == digest of the report's keyset.
  const workloadKeysetDigest = await computeKeysetDigest(keyset);
  pushEqual(checks, "workload_keyset_digest", report.workload_keyset_digest, workloadKeysetDigest);

  // Check 4 (binding half): report_data == the §4.4 statement digest for this nonce.
  // The hardware-evidence-binds-report_data half is verifyHardwareQuote's job.
  const expectedReportData = await computeReportData(workloadId, workloadKeysetDigest, nonce);
  pushEqual(checks, "report_data", report.attestation.report_data, expectedReportData);

  // Check 5: keyset endorsement verifies under the identity key, algo matching.
  const endorsement = report.attestation.keyset_endorsement;
  if (endorsement.algo !== identityKey.algo) {
    checks.push({
      name: "keyset_endorsement",
      ok: false,
      detail: `endorsement.algo "${endorsement.algo}" != identity key algo "${identityKey.algo}"`,
    });
  } else {
    const ok = await verifySecp256k1(
      identityKey.public_key,
      endorsement.value,
      keysetEndorsementPayload(workloadKeysetDigest),
    );
    checks.push({
      name: "keyset_endorsement",
      ok,
      ...(ok ? {} : { detail: "endorsement signature failed under identity key" }),
    });
  }

  // Check 6: freshness. Nonce binding is check 4; here bound the epoch and, when
  // the profile trusts it, the declared validity window.
  const notAfter = keyset.keyset_epoch.not_after;
  const epochOk = now < notAfter;
  checks.push({
    name: "keyset_epoch.not_after",
    ok: epochOk,
    ...(epochOk ? {} : { detail: `now ${now} >= not_after ${notAfter}` }),
  });
  if (options.trustPlatformClock) {
    const freshness = report.attestation.freshness;
    const fetchedAt = freshness?.fetched_at;
    const staleAfter = freshness?.stale_after;
    const windowOk =
      typeof fetchedAt === "number" &&
      typeof staleAfter === "number" &&
      fetchedAt <= now &&
      now < staleAfter;
    checks.push({
      name: "freshness_window",
      ok: windowOk,
      ...(windowOk ? {} : { detail: `now ${now} outside [${fetchedAt}, ${staleAfter})` }),
    });
  }

  return { ok: checks.every((c) => c.ok), checks, workloadId, workloadKeysetDigest };
}

/**
 * §4.3 secp256k1 endorsement: a 64-byte `r || s` signature over
 * `sha256(payload bytes)`. Returns false on malformed input rather than throwing —
 * a bad signature is a failed check, not an exception.
 *
 * NOT the §8.5 *receipt* shape, which is a 65-byte recoverable `r || s || v` and
 * where the spec says 64-byte signatures MUST be rejected. Different shapes; easy
 * to conflate if this ever grows a receipt path.
 */
async function verifySecp256k1(
  publicKeyHex: string,
  signatureHex: string,
  payload: Uint8Array,
): Promise<boolean> {
  try {
    const sig = fromHex(signatureHex);
    if (sig.length !== 64) return false; // r||s only; DER / recoverable forms are not §4.3
    const msgHash = await sha256(payload);
    return secp256k1.verify(sig, msgHash, publicKey(publicKeyHex), {
      prehash: false, // we hand it the sha256 digest, per §4.3
      // Accept high-s as well as low-s. ECDSA malleability is meaningless for a
      // signature over a FIXED payload — an attacker who can flip s already has a
      // valid endorsement and still cannot sign a different keyset digest. Leaving
      // the default on would reject ~half of otherwise-valid endorsements from any
      // signer that doesn't normalize, as an intermittent attestation failure.
      lowS: false,
    });
  } catch {
    return false;
  }
}

/**
 * Identity key bytes. §7.1 pins secp256k1 public keys as 65-byte uncompressed SEC1
 * and requires that "the 64-byte uncompressed form without the `0x04` prefix MUST be
 * accepted and treated as the same key" — so restore the prefix when it's absent.
 * The live gateway sends the 65-byte form; do NOT prefix that one again.
 */
function publicKey(hex: string): Uint8Array {
  const raw = fromHex(hex);
  if (raw.length === 64) {
    const sec1 = new Uint8Array(65);
    sec1[0] = 0x04;
    sec1.set(raw, 1);
    return sec1;
  }
  return raw;
}

function pushEqual(checks: Check[], name: string, actual: string, expected: string): void {
  const ok = actual === expected;
  checks.push({ name, ok, ...(ok ? {} : { detail: `report ${actual} != recomputed ${expected}` }) });
}
