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
