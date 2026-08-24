/**
 * Report binding checks a verifier can run with pure Web Crypto — §9.1 check 2
 * (binding and freshness: keyset bytes → digest → statement → `report_data`)
 * and check 3 (expiry), plus the aci/1 protocol gate. Check 1 (the hardware
 * quote verifies to the vendor root and binds `report_data`) is done by
 * ../../phalaSeal.ts with @phala/dcap-qvl; checks 5–6 (custody, channel) stay
 * policy / caller territory.
 *
 * Local omission (see VENDORED.md): upstream's `verifyQuote` and
 * `verifyComposeMeasurement` live in this file too. They are not carried here —
 * phalaSeal.ts owns the quote (it also gates TCB status and pins measurements)
 * and measurements.ts owns the event-log replay across all four RTMRs. Leaving
 * them out keeps this tree dependency-free and @phala/dcap-qvl off the import
 * path of every startup.
 */

import { computeKeysetDigest, computeReportData } from './digest';
import type { AttestationReport, Check, ReportVerification, WorkloadKeyset } from './types';

/** Options for {@link verifyReportBinding}. */
export interface ReportBindingOptions {
  /**
   * Current time in Unix seconds for the expiry check (§9.1 check 3).
   * Defaults to the local clock; pass an explicit value for deterministic tests.
   */
  now?: number;
}

/**
 * Verify the report's cryptographic bindings for `nonce` — the value this
 * client sent to `GET /v1/aci/attestation`, or `null`/`undefined` when it sent
 * none (§3.2). One recomputation establishes that the keyset is exactly what
 * the quote bound and that the quote postdates the challenge (§9.1 check 2).
 *
 * Returns per-check results plus the established keyset (digest, exact bytes,
 * parsed form); a failed check on the served report is `ok: false`, never
 * thrown. The one exception is the caller's own input: a nonce that is not
 * 64 lowercase hex throws {@link AciFormatError} (§3.2).
 */
export async function verifyReportBinding(
  report: AttestationReport,
  nonce: string | null | undefined,
  options: ReportBindingOptions = {},
): Promise<ReportVerification> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const checks: Check[] = [];

  // Protocol gate (Appendix B): artifacts with another version are rejected.
  const versionOk = report.api_version === 'aci/1';
  checks.push({
    name: 'api_version',
    ok: versionOk,
    ...(versionOk ? {} : { detail: `api_version "${report.api_version}" is not "aci/1"` }),
  });

  const keysetValue = report.attestation.workload_keyset;
  if (keysetValue === null || typeof keysetValue !== 'object' || Array.isArray(keysetValue)) {
    const detail = 'workload_keyset is not a JSON object';
    for (const name of ['workload_keyset_digest', 'report_data', 'not_after']) {
      checks.push({ name, ok: false, detail });
    }
    return { ok: false, checks };
  }

  // §9.1 check 2: recompute the whole chain from the served keyset object —
  // canonicalize exactly what was parsed, unknown members included. The
  // recomputed digest is authoritative (Appendix A) — the report's restated copy is
  // checked for consistency but never feeds the statement.
  const digest = await computeKeysetDigest(keysetValue);
  pushEqual(checks, 'workload_keyset_digest', report.workload_keyset_digest, digest);
  const expectedReportData = await computeReportData(digest, nonce);
  pushEqual(checks, 'report_data', report.attestation.report_data, expectedReportData);

  const keyset = keysetValue as WorkloadKeyset;

  // §9.1 check 3: now < not_after in the decoded keyset.
  if (typeof keyset.not_after !== 'number') {
    checks.push({
      name: 'not_after',
      ok: false,
      detail: 'keyset has no numeric not_after',
    });
  } else {
    const ok = now < keyset.not_after;
    checks.push({
      name: 'not_after',
      ok,
      ...(ok ? {} : { detail: `now ${now} >= not_after ${keyset.not_after}` }),
    });
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
    workloadKeysetDigest: digest,
    keyset,
  };
}

function pushEqual(checks: Check[], name: string, actual: string, expected: string): void {
  const ok = actual === expected;
  checks.push({ name, ok, ...(ok ? {} : { detail: `report ${actual} != recomputed ${expected}` }) });
}
