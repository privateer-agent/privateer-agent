// The out-of-band attestation interposer — THE MOAT, preserved.
//
// Pi's extension hooks CANNOT reach the TLS peer certificate: pi-ai strips the
// provider response down to { status, headers } before any extension sees it, so
// there is no seam inside Pi to read `socket.getPeerCertificate()`. The fix
// (spike-A proven, see ../../ pi-spike/spike-a.mjs) is a PROCESS-WIDE undici
// global dispatcher installed out-of-band, before any Pi import. Pi's provider
// requests go through Node's global fetch, which honors the global dispatcher,
// so the enclave's TLS SPKI hash — exactly what a Tinfoil attestation report
// pins — is captured on the `connect` hook without forking pi-ai.
//
// Phase 3 (see docs/pi-migration-plan.md §Appendix A.3) grows this file: the
// pure attestation logic from tree-cli/src/providers/attestation.ts
// (interpretReport, interpretTinfoilDoc, teePosture, SEV-SNP report_data parse)
// ports in verbatim, and this connect-hook becomes the `TinfoilTransport` that
// returns { doc, liveTlsKeyFp }. For now this is the capture half only.

import crypto from "node:crypto";
import { Agent, buildConnector, setGlobalDispatcher } from "undici";

export interface CapturedCert {
  subject: string;
  issuer: string;
  // SHA-256 of the peer cert's SubjectPublicKeyInfo (SPKI DER). This is the
  // value a Tinfoil attestation report pins — the enclave TLS key fingerprint.
  spkiSha256: string;
  fingerprint256?: string;
  error?: string;
}

// host -> captured cert. Keyed per-host because undici pools keep-alive sockets:
// the `connect` hook fires ONLY on a NEW connection, so a reused socket skips it.
// We cache the first capture per host and never re-derive on pooled reuse. Do NOT
// pre-pool a connection to an attested host before the first attestation read, or
// the handshake we want to inspect gets skipped (spike-verified footgun).
const captured = new Map<string, CapturedCert>();

let installed = false;

// Install the global dispatcher. MUST run before any Pi import (see boot.ts).
// Idempotent: safe to call more than once; only the first call takes effect.
export function installAttestationDispatcher(): void {
  if (installed) return;
  installed = true;

  const baseConnect = buildConnector({});
  const attestingConnector: typeof baseConnect = (opts, cb) =>
    baseConnect(opts, (err, socket) => {
      const host = opts.hostname;
      if (
        !err &&
        socket &&
        host &&
        !captured.has(host) &&
        typeof (socket as any).getPeerCertificate === "function"
      ) {
        try {
          const cert = (socket as any).getPeerCertificate(true);
          if (cert && cert.raw) {
            const spkiDer = new crypto.X509Certificate(cert.raw).publicKey.export({
              type: "spki",
              format: "der",
            });
            captured.set(host, {
              subject: cert.subject?.CN ?? JSON.stringify(cert.subject),
              issuer: cert.issuer?.O ?? cert.issuer?.CN ?? JSON.stringify(cert.issuer),
              spkiSha256: crypto.createHash("sha256").update(spkiDer).digest("hex"),
              fingerprint256: cert.fingerprint256,
            });
          }
        } catch (e) {
          captured.set(host, { error: String(e) } as CapturedCert);
        }
      }
      cb(err, socket as any);
    });

  setGlobalDispatcher(new Agent({ connect: attestingConnector, connectTimeout: 8000 }));
}

// The SPKI fingerprint captured for a host, if any. Phase 3's Tinfoil transport
// reads this to satisfy `fetchTinfoilAttestation(cfg, transport)` and compare the
// live TLS key against the attestation report.
export function getCapturedCert(host: string): CapturedCert | undefined {
  return captured.get(host);
}

// Test/inspection escape hatch: snapshot of everything captured this process.
export function capturedHosts(): ReadonlyMap<string, CapturedCert> {
  return captured;
}
