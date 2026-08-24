/**
 * @phala/aci-verifier — a zero-dependency ACI verifier for the browser and node.
 *
 * Report binding (§9.1 checks 2–3) establishes the workload keyset: the served
 * keyset canonicalizes to the digest the attestation statement hashes into
 * `report_data`, which the hardware quote signs. Everything downstream — the
 * E2EE key we seal to, receipt signing keys, TLS pins — is a member of that one
 * quote-bound object, so nothing else needs its own signature. Receipt
 * verification (§9.3) runs against an established keyset. All crypto here is
 * Web Crypto (Ed25519, SHA-256/384); the quote itself is ../../phalaSeal.ts.
 */

// Canonicalization (Appendix A)
export { canonicalize, jcsBytes } from './jcs';
export type { JcsValue } from './jcs';

// Crypto primitives (Web Crypto only)
export {
  sha256,
  sha384,
  sha256Hex,
  sha256Prefixed,
  verifyEd25519,
  toHex,
  fromHex,
  toBase64,
  fromBase64,
} from './crypto';

// Digest constructions (Appendix A, §3.1, §3.2)
export { computeKeysetDigest, attestationStatement, computeReportData } from './digest';

// Attested sessions: content addressing and evidence (§8, §9.3)
export { computeSessionId, checkSessionApiVersion, checkSessionEvidence } from './session';

// E2EE v2 AAD builders (spec/e2ee-v2.md §6)
export {
  requestAad,
  requestAadString,
  responseAad,
  responseAadString,
} from './e2ee';
export type { AadCommon } from './e2ee';

// E2EE v2 channel to a verified workload — encrypt requests, decrypt replies
export { openE2eeChannel } from './e2ee-channel';
export type { E2eeChannel } from './e2ee-channel';

// Receipt verification (§9.3)
export {
  verifyReceipt,
  findEvent,
  hashBody,
  checkRequestBodyHash,
  checkResponseBodyHash,
} from './receipt';

// Report binding (§9.1 checks 2–3)
export { verifyReportBinding } from './report';
export type { ReportBindingOptions } from './report';

// Errors
export { AciError, AciFormatError } from './errors';

// Wire & result types
export type {
  KeysetKey,
  TlsKeyPin,
  WorkloadKeyset,
  SourceProvenance,
  Attestation,
  AttestationReport,
  ReceiptEnvelope,
  ReceiptEvent,
  ReceiptPayload,
  SessionEvidence,
  SessionRecord,
  Check,
  ReceiptVerification,
  ReportVerification,
} from './types';
