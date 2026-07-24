/**
 * @dstack/aci-verifier — a zero-dependency ACI Level 1 verifier.
 *
 * Level 1 (receipt verification, §10.2) is fully implemented against an
 * established keyset. {@link verifyReportBinding} adds the cryptographic-binding
 * checks of Level 2 (§10.1 checks 2–6); the hardware quote, key custody, and
 * provenance checks (§10.1 checks 1, 7–10) are verifier-profile territory and
 * out of scope here. All crypto is Web Crypto (Ed25519, SHA-256); `ecdsa-secp256k1`
 * is unsupported (not in the Web Crypto API) and raises a clear error.
 */

// Canonicalization (§3)
export { canonicalize, jcsBytes } from './jcs';
export type { JcsValue } from './jcs';

// Crypto primitives (Web Crypto only)
export {
  sha256,
  sha256Hex,
  sha256Prefixed,
  verifyEd25519,
  verifySignature,
  toHex,
  fromHex,
} from './crypto';

// Digest & canonical-signing-bytes constructions (§4, §8.5, §9.2)
export {
  computeWorkloadId,
  computeKeysetDigest,
  attestationStatement,
  computeReportData,
  keysetEndorsementPayload,
  keysetRevocationPayload,
  receiptSigningBytes,
  sessionMaterial,
  computeSessionId,
} from './digest';

// E2EE AAD builders (§7.3)
export {
  requestAad,
  requestAadString,
  responseAad,
  responseAadString,
} from './e2ee';
export type { AadCommon } from './e2ee';

// E2EE channel to a verified workload — encrypt requests, decrypt replies (§7)
export { openE2eeChannel } from './e2ee-channel';
export type { E2eeChannel } from './e2ee-channel';

// Level 1 receipt verification (§10.2)
export {
  verifyReceipt,
  findEvent,
  hashBody,
  checkRequestBodyHash,
  checkResponseWireHash,
  checkResponseCleartextHash,
} from './receipt';

// Level 2 report-binding checks (§10.1 checks 2–6, no hardware quote)
export { verifyReportBinding } from './report';
export type { ReportBindingOptions } from './report';

// Errors
export { AciError, AciFormatError, UnsupportedAlgorithmError } from './errors';

// Wire & result types
export type {
  PublicKey,
  WorkloadIdentity,
  ReceiptSigningKey,
  WorkloadKeyset,
  ReceiptSignature,
  ReceiptEvent,
  Receipt,
  Endorsement,
  Attestation,
  AttestationReport,
  SessionEvidence,
  SessionRecord,
  Check,
  ReceiptVerification,
  ReportVerification,
} from './types';
