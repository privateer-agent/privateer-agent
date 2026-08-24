// Phala (ACI E2EE) sealed transport for the account channel — the Node port of
// treeview's client PhalaProvider.
//
// Where Tinfoil seals the whole body at the transport layer (EHBP via SecureClient),
// Phala's Attested Confidential Inference encrypts the request's *content fields*
// (x25519-aes-256-gcm-hkdf-sha256) to the enclave's attested X25519 key, sends the
// `X-E2EE-*` headers alongside, and decrypts the response fields. The Privateer relay
// (`${server}/api/sealed/phala`, treeview/server/routes/sealed.js) injects PHALA_API_KEY
// and forwards ciphertext — it can't read prompts or responses.
//
// Crypto is the vendored aci-verifier (./phala/aci-verifier), pure Web Crypto
// (X25519/HKDF/AES-GCM/Ed25519). Node ≥ 22 provides all of it on globalThis.crypto —
// no polyfills, unlike the RN app.
//
// Two-layer attestation, fail-secure:
//   (1) verifyReportBinding — the report's crypto binding (§9.1 checks 2–3): the
//       served keyset canonicalizes to the digest that the attestation statement for
//       OUR nonce hashes into report_data, and the keyset has not expired. Every key
//       we go on to use — the X25519 key we seal to above all — is a member of that
//       one object, so the binding covers them without a separate signature.
//   (2) verifyHardwareQuote — the hardware root: @phala/dcap-qvl verifies the TDX quote
//       against Intel collateral and binds the quote's report_data to (1)'s statement
//       digest. requireQuote defaults TRUE; PRIVATEER_PHALA_REQUIRE_QUOTE=0 drops it
//       (local testing only — removes the hardware root of trust).

import type { Report } from "@phala/dcap-qvl";
import {
  openE2eeChannel,
  verifyReportBinding,
  toHex,
  fromHex,
  type AttestationReport,
  type ReportVerification,
  type E2eeChannel,
} from "./phala/aci-verifier/index.ts";
import {
  parseEventLog,
  appIdentityFrom,
  checkReportConsistency,
  type PhalaAppIdentity,
} from "./phala/measurements.ts";
import { checkPin, type PinResult } from "./phala/pin.ts";
import { serverBaseUrl } from "../auth/privateer.ts";

const DEFAULT_ACCEPTABLE_TCB = ["UpToDate"];

function relayBase(): string {
  return `${serverBaseUrl().replace(/\/+$/, "")}/api/sealed/phala`;
}

// Hardware quote check on by default (fail-secure). Only "0"/"false" disables it.
function requireQuote(): boolean {
  const v = process.env.PRIVATEER_PHALA_REQUIRE_QUOTE;
  return !(v === "0" || v === "false");
}
function pccsUrl(): string | undefined {
  return process.env.PRIVATEER_PHALA_PCCS_URL || undefined;
}
function acceptableTcb(): Set<string> {
  const v = process.env.PRIVATEER_PHALA_TCB;
  const list = v ? v.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ACCEPTABLE_TCB;
  return new Set(list);
}

// The launch measurements carried by a verified TDX quote. MRTD measures the initial
// TD build (the dstack OS image); RTMR0-2 accumulate firmware/kernel/config and RTMR3
// carries the app-level extensions (compose hash, app id).
//
// READING these is not CHECKING them. Nothing here compares a measurement against a
// known-good value, so they are evidence to display and pin later — never a verdict.
// The quote's signature is verified before we get here, so the bytes are authentic:
// what is unproven is that this particular image is the one we intend to be talking to.
export interface PhalaMeasurements {
  mrTd: string;
  rtMr0: string;
  rtMr1: string;
  rtMr2: string;
  rtMr3: string;
}

// Pull the measurements off a verified quote report (TD1.0/1.5 layouts), or undefined
// when the report carries no TD measurement block (e.g. an SGX quote).
export function extractQuoteMeasurements(report: Report): PhalaMeasurements | undefined {
  const td = report.asTd10?.() ?? report.asTd15?.()?.base;
  const fields = [td?.mrTd, td?.rtMr0, td?.rtMr1, td?.rtMr2, td?.rtMr3];
  // All five or none. A partial set still reads as evidence while silently omitting
  // the register that would have contradicted it — RTMR3 (the app layer) most of all.
  if (fields.some((f) => !f?.length)) return undefined;
  const [mrTd, rtMr0, rtMr1, rtMr2, rtMr3] = fields.map((f) => toHex(new Uint8Array(f as Uint8Array)));
  return { mrTd, rtMr0, rtMr1, rtMr2, rtMr3 };
}

// Everything we can say about the enclave that answered, once its quote verified.
// `measurements` and `identity` are what the hardware signed; `pin` is our own memory
// of it; the provenance and downstream fields are the enclave's self-declarations,
// carried for display precisely because they are NOT proven by the quote.
export interface PhalaEnclaveIdentity {
  measurements: PhalaMeasurements;
  identity: PhalaAppIdentity;
  pin: PinResult;
  // Self-consistency checks we could not run (absent event log / app_compose). Named
  // so "we didn't check" can never be read as "we checked and it passed".
  skippedChecks: string[];
  repoUrl?: string;
  repoCommit?: string;
  downstreamDomain?: string;
  downstreamSpkiSha256?: string;
}

// The 64-byte report_data from a verified TDX quote report (TD1.0/1.5 layouts).
function extractQuoteReportData(report: Report): Uint8Array {
  const td10 = report.asTd10?.();
  if (td10?.reportData) return new Uint8Array(td10.reportData);
  const td15 = report.asTd15?.();
  if (td15?.base?.reportData) return new Uint8Array(td15.base.reportData);
  const data = report.data as { reportData?: Uint8Array } | undefined;
  if (data?.reportData) return new Uint8Array(data.reportData);
  throw new Error("phala: verified quote report has no reportData");
}

interface VerifiedAttestation {
  report: AttestationReport;
  verification: ReportVerification;
  // Absent when the hardware quote was skipped (requireQuote off): with no verified
  // quote there is nothing about the enclave we are entitled to show.
  enclave?: PhalaEnclaveIdentity;
}

// Attest once, cache the verified report; drop the memo on failure so a later call
// re-attests rather than caching the error.
let attestationPromise: Promise<VerifiedAttestation> | null = null;

function attest(): Promise<VerifiedAttestation> {
  if (!attestationPromise) {
    attestationPromise = establishAttestation().catch((err) => {
      attestationPromise = null;
      throw err as Error;
    });
  }
  return attestationPromise;
}

export function resetPhala(): void {
  attestationPromise = null;
}

async function establishAttestation(): Promise<VerifiedAttestation> {
  const nonce = toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  // The relay proxies GET /attestation?nonce=… → the gateway's
  // GET /v1/aci/attestation?nonce=… (public; no user content).
  const res = await fetch(`${relayBase()}/attestation?nonce=${nonce}`, { method: "GET" });
  if (!res.ok) throw new Error(`phala attestation HTTP ${res.status}`);
  const report = (await res.json()) as AttestationReport;

  const verification = await verifyReportBinding(report, nonce);
  if (!verification.ok) {
    const failed = verification.checks.filter((c) => !c.ok).map((c) => c.name).join(", ");
    throw new Error(`phala attestation binding failed: ${failed}`);
  }
  const enclave = await verifyHardwareQuote(report);
  return { report, verification, enclave };
}

async function verifyHardwareQuote(report: AttestationReport): Promise<PhalaEnclaveIdentity | undefined> {
  if (!requireQuote()) return undefined;

  const attestation = report.attestation as unknown as {
    tee_type?: string;
    report_data?: string;
    source_provenance?: { repo_url?: string; repo_commit?: string };
    evidence?: {
      quote?: string;
      quote_report_data?: string;
      event_log?: unknown;
      app_compose?: unknown;
      downstream_tls_binding?: { domain?: string; spki_sha256?: string };
    };
  };
  const teeType = String(attestation?.tee_type || "");
  if (teeType !== "tdx") throw new Error(`phala: unsupported/absent tee_type "${teeType}" (only tdx is wired)`);
  const quoteHex = attestation.evidence?.quote;
  if (typeof quoteHex !== "string" || !quoteHex) throw new Error("phala: attestation evidence has no TDX quote");
  const reportDataHex = String(attestation.report_data || "").toLowerCase();
  if (!reportDataHex) throw new Error("phala: report has no report_data");

  // Verify the quote against fetched Intel/Phala collateral (pure-JS dcap-qvl).
  const { getCollateralAndVerify } = await import("@phala/dcap-qvl");
  const verified = await getCollateralAndVerify(fromHex(quoteHex), pccsUrl());

  // 1) Genuine hardware + acceptable TCB status.
  const status = String(verified.status);
  if (!acceptableTcb().has(status)) throw new Error(`phala: TDX quote TCB status not accepted: "${status}"`);

  // 2) The genuine quote committed to our attested statement digest.
  const quoteReportData = extractQuoteReportData(verified.report);
  if (toHex(quoteReportData.slice(0, 32)) !== reportDataHex) {
    throw new Error("phala: TDX quote report_data does not bind the attested report_data");
  }

  // 3) Consistency: the report's declared quote_report_data matches the real quote.
  const declared = attestation.evidence?.quote_report_data;
  if (typeof declared === "string" && declared && toHex(quoteReportData) !== declared.toLowerCase()) {
    throw new Error("phala: evidence.quote_report_data does not match the verified quote");
  }

  // 4) The quote is authentic, so its measurement registers are trustworthy bytes.
  const measurements = extractQuoteMeasurements(verified.report);
  if (!measurements) return undefined; // non-TD quote: nothing further to check

  // 5) SELF-CONSISTENCY GATES. The event log must replay to the registers the hardware
  //    signed, and the shipped app_compose must hash to the compose-hash the log
  //    attests. Both are checkable from the report alone, so a failure means the report
  //    is doctored or malformed — refuse it rather than showing a green shield over it.
  const events = parseEventLog(attestation.evidence?.event_log);
  const identity = appIdentityFrom(events);
  const consistency = checkReportConsistency({
    events,
    quoted: measurements,
    appCompose: attestation.evidence?.app_compose,
    identity,
  });
  if (!consistency.ok) {
    const failed = consistency.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join("; ");
    throw new Error(`phala: attestation self-consistency failed: ${failed}`);
  }

  // 6) IDENTITY, as evidence only. TOFU against the stored pin — this can say the image
  //    CHANGED, never that it is the right one (no published registry to check against;
  //    see phala/pin.ts). It moves no verdict and never throws.
  const pin = checkPin({
    mrTd: measurements.mrTd,
    rtMr0: measurements.rtMr0,
    rtMr1: measurements.rtMr1,
    rtMr2: measurements.rtMr2,
    appId: identity.appId,
    composeHash: identity.composeHash,
    osImageHash: identity.osImageHash,
    mrKms: identity.mrKms,
  });

  const provenance = attestation.source_provenance;
  const downstream = attestation.evidence?.downstream_tls_binding;
  return {
    measurements,
    identity,
    pin,
    skippedChecks: consistency.skipped,
    // Named so a human can go read the source; self-declared by the enclave and NOT
    // proven by the quote (image_digest/image_provenance come back null), so it is a
    // pointer to audit, never evidence that this binary came from that commit.
    repoUrl: provenance?.repo_url,
    repoCommit: provenance?.repo_commit,
    // The attested enclave forwards to this downstream host over TLS. Surfaced because
    // it marks where our attested boundary ENDS — that host is a separate trust domain
    // we do not attest.
    downstreamDomain: downstream?.domain,
    downstreamSpkiSha256: downstream?.spki_sha256,
  };
}

// Posture signal: does the attested keyset verify (crypto binding + hardware quote)?
// A green result is a quote WE checked, bound to the E2EE key we seal to. The
// measurements ride along as evidence of WHICH image answered — unpinned, so they
// inform the display without moving the verdict.
export async function attestPhala(): Promise<{
  ok: boolean;
  error?: string;
  enclaveIdentity?: PhalaEnclaveIdentity;
}> {
  try {
    const { enclave } = await attest();
    return { ok: true, enclaveIdentity: enclave };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export interface PhalaExchange {
  res: Response;
  channel: E2eeChannel;
  streaming: boolean;
}

// Run one sealed request for Pi: attest, open a fresh per-call E2EE channel (the
// channel's request state is single-shot → not safe to share across concurrent
// calls), seal the request fields, and POST to the relay with the X-E2EE-* headers +
// the cleartext X-Sealed-Model (relay billing) + Pi's account bearer. Returns the
// upstream response and the channel so the caller can decrypt it.
export async function phalaSealedFetch(
  rawBody: string,
  authHeader: string | undefined,
  signal?: AbortSignal,
): Promise<PhalaExchange> {
  const { report, verification } = await attest();
  const channel = await openE2eeChannel(report, verification);

  let request: Record<string, unknown>;
  try {
    request = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new Error("phala: request body is not JSON");
  }
  const fullModel = typeof request.model === "string" ? request.model : "unknown";
  const streaming = request.stream !== false;
  // Bare model id for the enclave (the `phala/` prefix is app-side only); keep the
  // full id on the cleartext X-Sealed-Model billing header.
  request.model = fullModel.replace(/^phala\//, "");
  request.stream = streaming;

  const { body, headers: e2ee } = await channel.seal(request);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Sealed-Model": fullModel,
    ...e2ee,
  };
  if (authHeader) headers.Authorization = authHeader;

  const res = await fetch(`${relayBase()}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  return { res, channel, streaming };
}
