# Vendored: `@dstack/aci-verifier`

Faithful copy of the zero-dependency TypeScript ACI verifier from
[Dstack-TEE/private-ai-gateway](https://github.com/Dstack-TEE/private-ai-gateway)
(`clients/verifier-ts/src`), Apache-2.0. It is `private: true` upstream (not on
npm), so it is vendored here rather than installed.

Provides the pieces `PhalaProvider` needs:
- **`verifyReportBinding`** (`report.ts`) — §10.1 checks 2–6 (crypto binding of the
  attestation report to the attested keyset for a supplied nonce). NOT the hardware
  TDX quote (check 1) — that is layered on with `@phala/dcap-qvl` in the provider.
- **`openE2eeChannel`** (`e2ee-channel.ts`) — the ACI E2EE channel:
  `x25519-aes-256-gcm-hkdf-sha256`, per-field seal/open, `X-E2EE-*` headers.

## Local adaptation (the only change from upstream)
- Relative import specifiers had their `.js` extension stripped (`'./jcs.js'` →
  `'./jcs'`) so Metro + TS (`moduleResolution: bundler`) resolve to the `.ts` files.

Everything else is byte-for-byte upstream. The crypto runs on `globalThis.crypto`
(Web Crypto: X25519, HKDF, AES-GCM, Ed25519, `getRandomValues`). In privateer-agent
(Node ≥ 22) these are all native — **no polyfills needed** (unlike the treeview RN app,
which bridges them via `react-native-quick-crypto`). Re-pull from upstream to update;
re-apply only the `.js`-extension strip.

## What lives OUTSIDE this directory (and why)
`../reportBinding.ts` — `verifyAciReportBinding`, the algorithm dispatch for §10.1
checks 2–6. Callers use it instead of importing `verifyReportBinding` from here.

Upstream's verifier is Web-Crypto-only, so it throws `UnsupportedAlgorithmError` on
an `ecdsa-secp256k1` keyset endorsement — which §4.3 explicitly permits alongside
ed25519, and which the deployed `inference.phala.com` gateway actually uses. Rather
than patch this tree (and re-patch it on every re-pull), the dispatch sits outside:
ed25519 delegates here verbatim, secp256k1 takes a parallel path over `@noble/curves`,
and any other algorithm still throws. Nothing here changed, so the re-pull recipe
above stays exactly the `.js`-extension strip.

If upstream ever adds secp256k1 (or a check 7) to `report.ts`, collapse
`reportBinding.ts` back to a straight re-export — `tests/phalaReportBinding.test.ts`
pins the behaviour either way.
