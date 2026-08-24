# Vendored: the ACI verifier

Copy of the zero-dependency TypeScript ACI verifier from
[Dstack-TEE/private-ai-gateway](https://github.com/Dstack-TEE/private-ai-gateway)
(`clients/verifier-ts/src`), Apache-2.0. It is `private: true` upstream (not on
npm), so it is vendored here rather than installed.

Current drop: commit `1a044e960fbec8ab20f38524bc93aa0ced83d5b0` — the `aci/1`
protocol, which is what `inference.phala.com` actually serves as of 2026-08-24.

Provides the pieces the Phala sealed transport needs:
- **`verifyReportBinding`** (`report.ts`) — §9.1 checks 2–3: the served keyset
  canonicalizes to the digest that the attestation statement for our nonce hashes
  into `report_data`, and the keyset has not expired. NOT the hardware TDX quote
  (check 1) — that is layered on with `@phala/dcap-qvl` in `../../phalaSeal.ts`.
- **`openE2eeChannel`** (`e2ee-channel.ts`) — the E2EE v2 channel:
  `x25519-aes-256-gcm-hkdf-sha256`, per-field seal/open, `X-E2EE-*` headers.

## Protocol note: what `aci/1` changed
The previous drop verified a *keyset endorsement*: the keyset carried a
`workload_identity` key, that key signed the keyset digest, and `workload_id` was
the digest of the identity key. `aci/1` removes all three. The keyset is now bound
straight into `report_data` — the statement is
`{"keyset_digest":…,"nonce":…,"purpose":"aci.report_data.v1"}` — so the hardware
quote is the only signature over it, and per-key custody (`evidence.key_custody`,
the dstack-KMS chain) is explicitly policy/caller territory (§9.1 checks 5–6),
which we do not check.

Practical consequence: a client written against the old shape does not degrade,
it *crashes* — `workload_keyset.workload_identity` is simply absent. That is what
broke sealed `phala/*` turns with `sealed shim: Cannot read properties of
undefined (reading 'public_key')` before this drop.

## Local adaptations (the only changes from upstream)
1. Relative import specifiers had their `.js` extension stripped (`'./jcs.js'` →
   `'./jcs'`) so Metro + TS (`moduleResolution: bundler`) resolve to the `.ts` files.
2. `jcs.ts` is kept as its own module. Upstream folded JCS into `crypto.ts` as a
   sort-and-`JSON.stringify` helper; ours is the stricter RFC 8785 implementation
   from the earlier drop (it *rejects* non-integer numbers rather than
   mis-serializing them), and the E2EE AAD builders depend on it. `digest.ts`,
   `receipt.ts`, and `session.ts` therefore import `jcsBytes` from `./jcs`
   instead of `./crypto`.
3. `report.ts` carries only `verifyReportBinding`. Upstream's `verifyQuote` and
   `verifyComposeMeasurement` are omitted: `../../phalaSeal.ts` owns the quote (it
   also gates TCB status and pins the measurements) and `../measurements.ts` owns
   the event-log replay across all four RTMRs, not just RTMR3. Omitting them keeps
   this tree dependency-free and `@phala/dcap-qvl` off every startup's import path.
4. `e2ee.ts` and `e2ee-channel.ts` are carried forward from the earlier drop.
   Upstream moved E2EE out of the verifier package ("specified by §6 but not
   constructed by this verifier"); the wire format itself is unchanged and still
   specified in `spec/e2ee-v2.md`, and the gateway still advertises
   `supported_e2ee_versions: ["2"]`.
5. `transcript.ts` (upstream's one-call `verifyService` + verdict rendering) is not
   vendored — `phalaSeal.ts` composes its own verdict and enclave identity.

Everything else is byte-for-byte upstream. The crypto runs on `globalThis.crypto`
(Web Crypto: X25519, HKDF, AES-GCM, Ed25519, SHA-384, `getRandomValues`). In
privateer-agent (Node ≥ 22) these are all native — **no polyfills needed** (unlike
the treeview RN app, which bridges them via `react-native-quick-crypto`).

Re-pull recipe: copy `clients/verifier-ts/src/*.ts`, strip the `.js` extensions,
then re-apply adaptations 2–5. `tests/phalaReportBinding.test.ts` pins the binding
behaviour against a real report captured from the live gateway.
