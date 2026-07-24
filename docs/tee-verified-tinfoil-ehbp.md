# Green shield for proxied Tinfoil — EHBP end-to-end encryption

> **Status (2026-07-24): client path implemented in privateer-agent for BOTH sealed
> providers (Tinfoil EHBP + Phala ACI E2EE), behind `PRIVATEER_SEALED=1`, pending a live
> end-to-end run.** The server relay (`treeview/server/routes/sealed.js`, provider-generic)
> and the treeview app's clients already shipped. This repo now has the Node clients:
> `src/providers/sealedShim.ts` (loopback shim + provider dispatch), `src/providers/phalaSeal.ts`
> (ACI E2EE + TDX-quote attestation) over the vendored `src/providers/phala/aci-verifier/`,
> sealed routing + posture flip in `src/providers/account.ts`; tests in
> `tests/sealedShim.test.ts` + `tests/phalaE2ee.test.ts` (full seal/open round-trip on Node
> Web Crypto). What remains is the live checklist at the bottom — no sealed byte has crossed a
> real relay from this CLI yet, so the flag stays off by default.

## The problem, in one line

On the `privateer` account channel, `tinfoil/*` models show **"⛉ Trusted Execution
(unconfirmed)"** (tier `tee-unverified`), never the green shield — see
`src/providers/account.ts:258-259` and the honesty note at `account.ts:251-257`. This
doc is the plan to make that badge honestly green.

## Why it's yellow today (and why that's currently correct)

Two providers, two different attestation bindings:

- **NEAR** binds to a caller-supplied *nonce* (`report_data = signing_address || nonce`,
  `pi-privacy/src/attest/attestation.ts:26-42`). A nonce is just data, so the privateer
  server can mint one, relay it, and get back a fresh report — the proof survives the
  proxy. That's why `near/*` can reach `tee-verified` via `accountPosture`
  (`account.ts:261-274`).
- **Tinfoil** (today, in our verifier) binds to the enclave's *outer TLS key*:
  `report_data[0x50:0x70]` is the SHA-256 of the enclave's TLS SPKI, and we confirm it by
  hashing the leaf cert on **the exact socket that served us** (`attestation.ts:258-268`,
  `httpsTransport` at `:163-194`). Through the proxy your client terminates TLS at the
  *proxy*, not the enclave, so `liveTlsKeyFp` can never equal `attestedTlsKeyFp`. The
  binding is genuinely false for your connection → honest `tee-unverified`.

**The invariant we must preserve:** the key the attestation binds to MUST be the key that
terminates the channel actually carrying our tokens. Never paint the shield green on a key
we can't tie to our own traffic. Everything below exists to satisfy this invariant through
a proxy — not to route around it.

## The unlock: Tinfoil already ships the inner channel (EHBP)

Tinfoil's **Encrypted HTTP Body Protocol** (EHBP) is HPKE (RFC 9180) applied to the HTTP
**body only**, at the application layer, *independent of TLS*. Two facts make it fit us
exactly:

1. **The attestation binds the HPKE key, not just the TLS key.** Tinfoil docs:
   *"a CPU attestation report that covers both the TLS key fingerprint and the HPKE public
   key."* Each enclave mints a fresh TLS keypair AND an HPKE keypair at boot. So a client
   that seals to the attested HPKE key has satisfied our invariant regardless of who
   terminates the outer TLS.
2. **Tinfoil publishes a "proxy in front of us" pattern** that is architecturally our
   account channel: API key stays on the backend, the proxy **never decrypts**, it only
   forwards two EHBP headers and injects `Authorization`.
   (https://docs.tinfoil.sh/guides/proxy-server). PayPerQ already runs this in production.

So the earlier "blocked until Tinfoil attests something other than the TLS SPKI" is wrong:
they already attest the HPKE key. This is ~90% privateer plumbing.

References: EHBP spec https://github.com/tinfoilsh/encrypted-http-body-protocol ·
Proxy guide https://docs.tinfoil.sh/guides/proxy-server ·
Verification https://docs.tinfoil.sh/verification/verification-in-tinfoil ·
tinfoil-js (`SecureClient`) https://github.com/tinfoilsh/tinfoil-js

---

## Architecture

Three moving parts; only one of them is source in *this* repo.

### 1. Privateer server proxy — `${server}/api/agent/v1` (NOT this repo)

Follow the Tinfoil backend-proxy contract verbatim for `tinfoil/*` (and `phala/*`) models:

- **Forward these headers UNCHANGED** — dropping/modifying either breaks decryption:
  - request → enclave: `Ehbp-Encapsulated-Key` (HPKE encapsulated key, 64 hex chars)
  - response → client: `Ehbp-Response-Nonce` (32-byte response nonce, 64 hex chars)
- **Never touch the body.** The proxy relays ciphertext; it holds no plaintext and no
  HPKE key. Preserve `Content-Type` and `Accept`.
- **Routing:** read `X-Tinfoil-Enclave-Url` from the client, **allowlist `*.tinfoil.sh`
  only**, forward `POST /v1/*` to that enclave.
- **Attestation route:** expose `GET /api/agent/v1/attestation` → proxy to the enclave's
  attestation bundle (`atc.tinfoil.sh/attestation` or the per-enclave URL). This is what
  the client verifies locally.
- **Auth stays server-side:** inject `Authorization: Bearer <TINFOIL_API_KEY>` (the
  account's key). The client presents only its existing account credential.
- **Streaming:** preserve chunked `Transfer-Encoding`, flush for SSE.
- **Billing survives the seal:** usage comes back in the `X-Tinfoil-Usage-Metrics`
  trailer, which the proxy CAN read (it's a header, not the sealed body). No metering
  regression — this was the main objection to any end-to-end scheme and it's already
  handled.

### 2. Client EHBP shim — in-process localhost (THIS repo)

Pi's `ProviderConfigInput` (`@earendil-works/pi-coding-agent .../core/model-registry.d.ts`)
exposes only `baseUrl` / `apiKey` / `api` / `headers` / `oauth` — **no custom-fetch hook**.
Pi's `openai-completions` adapter does the HTTP itself through its global undici dispatcher
(`core/http-dispatcher.js`). So we cannot seal the body from inside the provider config.

**Decision: run an in-process localhost EHBP shim** and point the provider at it. This is
the same shape as `tinfoil-cli`'s "verified proxy," kept inside our process:

```
Pi openai-completions adapter
   │  plain OpenAI request  (localhost, loopback only)
   ▼
privateer EHBP shim  (127.0.0.1:<ephemeral>)     ← THIS repo, new module
   │  1. on first request: GET ${server}/api/agent/v1/attestation
   │     verify bundle locally → enclave HPKE pubkey K  (cache per enclave)
   │  2. HPKE-seal request body to K, add Ehbp-Encapsulated-Key + X-Tinfoil-Enclave-Url
   │  3. attach account credential (authedFetch semantics)
   ▼
${server}/api/agent/v1  (privateer proxy, part 1)  →  tinfoil enclave
   ▲
   │  sealed response + Ehbp-Response-Nonce  (streamed)
   └─ shim HPKE-opens the body, streams plaintext SSE back to Pi
```

Notes:
- The shim binds `127.0.0.1` on an ephemeral port, refuses non-loopback peers, and holds
  **no long-lived secret** — the Tinfoil API key never leaves the server; the account
  credential is added exactly as `authedFetch` does today (`src/auth/privateer.ts:519`).
- Registration change is one line: for the EHBP path, set the provider `baseUrl` to the
  shim's `http://127.0.0.1:<port>/v1` instead of `${serverBaseUrl()}/api/agent/v1`
  (`account.ts:305`). `zdr` and `near/*` models keep their current baseUrl.
- **Use `SecureClient` from `tinfoil-js`** for the seal/open + bundle verification — it
  already "verifies that the HPKE key comes from an attested secure enclave." Confirmed
  (tinfoil-js README): `SecureClient` runs in **Node.js**, **supports SSE streaming**
  (`examples/streaming/`), and **exposes a `fetch` function** you hand to the OpenAI SDK so
  encryption is transparent. So the shim is a thin delegate: a loopback HTTP server whose
  handler forwards each request through `secureClient.fetch` and pipes the streamed,
  decrypted body back to Pi. No hand-rolled HPKE needed. `tinfoil-js` is NOT yet a
  dependency; add it.
- Why the shim at all if `SecureClient` already exposes `fetch`? Because Pi has no
  per-provider custom-fetch hook (see above) — the loopback server is how we inject
  `secureClient.fetch` into Pi's fixed `openai-completions` transport. (Alternative: patch
  Pi's global undici dispatcher via `patches/`; the shim is less invasive and self-owned.)
- Streaming is handled: `secureClient.fetch` decrypts SSE incrementally, so the shim just
  pipes the stream — no buffer-then-decrypt stall.

### 3. Posture — `accountPosture()` (THIS repo, `src/providers/account.ts`)

Only flip to green off the **same** attestation the shim actually sealed to — that is the
invariant, enforced in code, not just displayed.

- Remove the blanket `if (!modelId.startsWith("near/")) return { tier: "tee-unverified" }`
  (`account.ts:258-259`) for the Tinfoil branch.
- New branch for `tinfoil/*` (and `phala/*`):
  - Fetch + verify the enclave attestation bundle (reuse the shim's cached verification so
    posture and data plane agree on **one** key `K`).
  - **HPKE-key-match** replaces TLS-key-match: green iff (a) a TEE hardware predicate is
    present, (b) the bundle's attested HPKE key == the key the shim is sealing to, and
    (c) the shim is actually active for this model. Map that to `tee-verified`; anything
    short of it stays `tee-unverified` with the reason in `AccountPosture.error`.
- pi-privacy (`^0.3.0`, external — patch via `patches/` if needed) currently only knows
  TLS-key-match (`tinfoilTeePosture`, `attestation.ts:277-281`). Either add an
  `interpretSealedTinfoilDoc` there, or keep the HPKE-match check local to `account.ts`
  and treat `SecureClient.ready()` success as the signal. Local is lower-risk to start.

---

## Staging — never a dishonest green

Land it so the badge can only go green when tokens are genuinely sealed end-to-end. Each
stage is independently shippable and honest.

1. **Server proxy** implements the EHBP contract behind a flag. No client change. Verify
   with `tinfoil-cli` / `SecureClient` directly against `${server}/api/agent/v1`. Badge
   still yellow.
2. **Client shim** lands but is **off by default** (env/setting gated). When off, the
   provider baseUrl is unchanged and posture stays `tee-unverified`. Turn it on for dev,
   confirm real inference round-trips sealed.
3. **Posture flip** is gated on the shim being active AND HPKE-key-match passing for the
   selected model. Only now can `accountPosture` return `tee-verified`. If the shim is off,
   or key-match fails, or attestation fetch errors → `tee-unverified` (never silently
   green). The badge code (`extensions/privateer-posture.ts`) needs no change — it already
   renders `tee-verified` as the green shield.

## Verification checklist (the part automated tests can't cover)

Mirror `docs/mcp-live-verify.md`'s discipline — each step fails in exactly one place:

1. Server `GET /api/agent/v1/attestation` returns a bundle that `SecureClient`/`tinfoil-cli`
   verifies (hardware predicate present, HPKE key extracted).
2. A sealed `POST /v1/chat/completions` through the proxy returns a decryptable body — i.e.
   the proxy forwarded `Ehbp-Encapsulated-Key` / `Ehbp-Response-Nonce` untouched.
3. Streaming: tokens arrive incrementally through the shim (no buffer-then-dump stall).
4. Kill test: point `X-Tinfoil-Enclave-Url` at a non-allowlisted host → proxy rejects.
5. Tamper test: have the proxy drop `Ehbp-Response-Nonce` → client decryption fails loudly
   (proves we're not accidentally reading plaintext).
6. Posture: with shim on and key-match good → badge green; force key-mismatch → yellow with
   the reason surfaced. Confirm `X-Tinfoil-Usage-Metrics` still bills.

## Open questions

- ~~Does `SecureClient` stream SSE in Node?~~ **Resolved:** yes — Node.js, SSE streaming,
  and an OpenAI-SDK-compatible `fetch` (tinfoil-js README). Shim is a thin delegate.
- **Per-enclave attestation caching / rotation:** enclaves rotate keys on redeploy. How
  long do we cache `K`, and does the shim re-verify on `tlsKeyMatched`-style mismatch
  (compare to the direct path's fresh-handshake note, `attestation.ts:176-179`)?
- ~~**`phala/*`:** does it qualify?~~ **Ported + wired.** Phala uses ACI E2EE
  (`x25519-aes-256-gcm-hkdf-sha256`, per-field, not whole-body HPKE) with a two-layer
  attestation (`verifyReportBinding` + a TDX quote via `@phala/dcap-qvl`, fail-secure
  `requireQuote`). Client is `src/providers/phalaSeal.ts` over the vendored `aci-verifier/`;
  posture goes green off `attestPhala()`. Env: `PRIVATEER_PHALA_REQUIRE_QUOTE` / `_PCCS_URL` /
  `_TCB`. **Server billing wired** (`treeview/server/routes/sealed.js`): the relay injects
  `stream_options.include_usage=true` on streaming Phala requests (content-blind) so the
  cleartext `usage` it bills from always arrives → `calcPhalaCost` → `chargeUsd`. **Models
  surfaced**: all Phala TEE models load from `/v1/models` and are default-ON
  (`SEALED_MODELS_ENABLED=0` kill-switches; loader returns [] without `PHALA_API_KEY`).
  Remaining before flag-on-by-default: a live gateway round-trip.
- **pi-privacy home:** ~~HPKE-match verifier upstream vs. local~~ **Decided: local.** The
  HPKE-key-match is performed by the Tinfoil SDK inside `SecureClient.ready()` (it verifies
  the attestation bundle and binds the enclave HPKE key it seals to). `accountPosture` treats
  a green `ready()` on the shared client as the signal — no pi-privacy change needed. Revisit
  only if we want a second, independent verify.

## How it's wired (as built)

- **`src/providers/sealedShim.ts`** — one `SecureClient` per sealed provider
  (`transport: 'ehbp'`, `baseURL`/`attestationBundleURL` = `${server}/api/sealed/tinfoil`),
  shared by the data plane and posture. A loopback HTTP server (127.0.0.1, ephemeral,
  `unref`) receives Pi's plain OpenAI request, `buildForward()` strips the `tinfoil/` prefix
  from the body model + sets `X-Sealed-Model` (full id, for the relay's cleartext billing) +
  forwards Pi's account bearer, then `client.fetch` seals it and the decrypted stream pipes
  back.
- **`src/providers/phalaSeal.ts`** + **`src/providers/phala/aci-verifier/`** (vendored,
  zero-dep, pure Web Crypto) — the Phala path. `handlePhala` in the shim attests, opens a
  per-call ACI E2EE channel, seals the request's content fields, POSTs with `X-E2EE-*` +
  `X-Sealed-Model` + bearer, then decrypts the response (`openChunk` per SSE frame, or `open`
  for a buffered body) and re-emits cleartext OpenAI to Pi. Two-layer attestation
  (`verifyReportBinding` + TDX quote via `@phala/dcap-qvl`, `requireQuote` default true).
- **`src/providers/account.ts`** — `register()` gives `tinfoil/*` **and `phala/*`** a per-model
  `baseUrl` at the shim once it's listening (re-registers on shim-ready); `accountPosture()`
  returns `tee-verified` iff `attestSealed()` succeeds (Tinfoil: `SecureClient.ready()`;
  Phala: `attestPhala()`), else `tee-unverified` with the reason. Both gated on
  `sealedEnabled()` (`PRIVATEER_SEALED=1`).
- **Off by default:** flag off → sealed models keep the cleartext `/api/agent/v1` path and the
  honest yellow badge, exactly as before. Nothing about the working path changes until the flag
  flips.

## Live verification (do this before turning the flag on by default)

No sealed byte has crossed a real relay from this CLI yet. Ordered so each step fails in one place:

1. **Attestation reachable:** `curl -s ${server}/api/sealed/tinfoil/attestation` returns a
   bundle (hardware predicate present). Proves the relay's `/attestation` proxy + a live enclave.
2. **SDK attests:** in a Node REPL, `new SecureClient({baseURL, attestationBundleURL: baseURL,
   transport:'ehbp'}).ready()` resolves (~2s). Proves the HPKE-key-match end to end.
3. **Sealed round-trip:** `PRIVATEER_SEALED=1`, sign in, select `tinfoil/glm-5-2`, send a prompt.
   Confirm a normal answer **and** that the server logs a sealed turn billed off
   `X-Tinfoil-Usage-Metrics` (not UNBILLED).
4. **Streaming:** tokens arrive incrementally (the shim pipes SecureClient's decrypted SSE — on
   Node the body is readable, unlike RN).
5. **Badge:** the footer shows the green `⛉ Trusted Execution` (not "unconfirmed") for the
   selected tinfoil model; force an attestation failure (bad `baseURL`) → it stays yellow with
   the error, never a silent green.
6. **Auth refresh:** let a child token expire mid-session → relay 401 propagates → Pi refreshes
   and retries (the shim forwards Authorization verbatim; it owns no token).

Only after 1–6 pass against production should `PRIVATEER_SEALED` default on (or become
auto-sealed when a tinfoil model is selected, mirroring the app's §9.5 proposal).

## Bottom line

`tee-unverified` on proxied `tinfoil/*` is not fundamental — it's that privateer spoke plain
proxied HTTP instead of EHBP. The EHBP client now exists here (loopback shim over `SecureClient`
+ posture tied to the same client), reusing the already-shipped server relay. Once the live
checklist passes, the default `tinfoil/glm-5-2` badge turns green — honestly, tied to the key
that actually carries the tokens.
