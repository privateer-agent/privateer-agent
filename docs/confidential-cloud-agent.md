# Confidential Cloud Agent — spec (codename **Harbor**)

Status: draft / design. Author prompt: "do what Nous did (Hermes Agent in the Cloud), but the version that fits the privacy brand."

## 0. The one-line thesis

Nous ships a *cloud agent you trust*. We ship a **cloud agent you verify.** The hosted
agent runs inside a **TEE (Intel TDX confidential VM)**, and the client **remotely attests
the enclave before sending a single byte** of code, keys, or prompts — the exact
verify-don't-trust mechanism we already ship for *inference* (`pi-privacy/attest`,
`posture/tiers.ts`), now applied to the *agent runtime itself*.

The claim we get to make, honestly: **even Privateer (the operator) cannot read your
workspace, your keys, or your session.** Not a policy promise — a hardware guarantee whose
proof the client checks itself.

This is the harder path than a plain cloud agent, but it's the only version that doesn't
contradict "keep your own privacy," and it's a clean differentiator against Nous.

---

## 1. Why this is mostly a *rewiring* job, not a greenfield one

Four load-bearing subsystems already exist and get reused almost verbatim. The novelty is
concentrated in provisioning + the attested bootstrap.

| Capability | Where it lives today | Role in Harbor |
|---|---|---|
| **Headless agent runtime** | `src/harbor/index.ts` (runs a Pi session with no TUI, executes routines) | This is the process that runs **inside the enclave**. |
| **Remote control plane** | `src/remote/relayClient.ts` + `remoteBridge.ts`; server `routes/relay.js` + `services/relayHub.js` (Redis pub/sub, single-use 30s WS ticket, `agent`/`controller` roles) | **Flip the topology.** Today: agent=laptop, controller=phone. Harbor: agent=enclave VM, controller=web portal. Same protocol, same ticket redemption at WS upgrade. |
| **Remote attestation** | `pi-privacy/src/attest/{dispatcher,attestation}.ts` (undici global dispatcher captures TLS SPKI; NEAR/Tinfoil TDX quote fetch + nonce binding) | The *pattern* for attesting the **agent host**, and — reused unchanged **inside** the enclave — the way the enclave verifies its own outbound inference calls. |
| **Honest privacy ladder** | `pi-privacy/src/posture/tiers.ts` (`tee-verified` requires *cryptographic* evidence; never conflate verified vs asserted) | Extended with a **runtime-attestation** concept (§4). The honest-labeling contract governs the new badge. |
| **Accounts, device-auth, metered billing** | `src/auth/privateer.ts` (RFC 8628 device grant, child tokens); server `routes/{billing,deviceAuth,relay}.js`, `AGENT_CLI_MARKUP_FACTOR`, Stripe | Auth + "unified billing" ~done. Add a **compute** line item alongside the inference markup. |
| **Sealed-box E2EE** | `src/crypto/outboxSeal.ts` (`sealJson`, `decodeAccountPublicKey`) | The primitive for sealing the workspace/secrets **to the enclave's attested public key** (§3, step 4). |

What genuinely does **not** exist yet: (a) compute provisioning/orchestration of TDX VMs,
(b) the attested-bootstrap handshake, (c) a web org console, (d) persistent encrypted
workspaces. Those are §5's phases.

---

## 2. Architecture

```
┌────────────── client (privateer CLI  OR  web portal) ──────────────┐
│  1. request agent → 2. VERIFY enclave quote  → 3. seal secrets to  │
│     enclave key → 4. drive over relay (existing protocol)          │
└───────────────┬───────────────────────────────┬───────────────────┘
                │ control plane (existing)        │ attested bootstrap (new)
                ▼                                 ▼
        ┌───────────────┐               ┌───────────────────────────────┐
        │ Privateer srv │  provisions   │  Intel TDX Confidential VM     │
        │ (Render)      │──────────────▶│  ┌──────────────────────────┐  │
        │ relayHub      │◀─ relay WS ───│  │ harbor/index.ts (Pi)     │  │
        │ billing       │               │  │  + permission gate       │  │
        │ provisioner ★ │               │  │  + pi-privacy attest ────┼──┼──▶ TEE inference
        └───────────────┘               │  │  workspace vol (sealed)  │  │   (NEAR/Tinfoil,
              ★ = new                    │  └──────────────────────────┘  │    verified from
                                        │  memory encrypted by CPU (TDX) │    inside the enclave)
                                        └───────────────────────────────┘
```

The operator (Privateer / Render / the cloud host) sits **outside** the encryption
boundary. It can schedule, start, stop, and route the VM — but the guest memory (prompts,
files, keys, model I/O) is encrypted by the CPU and is opaque to it.

**End-to-end chain, unbroken:** verified agent runtime → *and* the agent's own inference
calls go to a TEE-attested endpoint that the enclave verifies with the same `pi-privacy`
code it runs today. Both links are cryptographic. That's the whole pitch in one sentence.

> Note: the agent host is **CPU-only TDX** — it delegates model inference to already-attested
> endpoints, so it needs no confidential GPU. GPU-CC (H100 CC) is only required if we later
> host the *model* in-house too (Phase 2, optional). This keeps MVP compute cheap and simple.

---

## 3. The attested bootstrap (the crux — this is the new security-critical code)

This is what makes it "verify, not trust." It runs **before** any user data leaves the client.

1. **Provision.** Client → `POST /harbor/agents {model, size}`. Provisioner boots a TDX CVM
   from a **pinned, reproducibly-built image** and returns `{agentId, attestUrl, relayTarget}`.
2. **Challenge.** Client generates a fresh 32-byte nonce (reuse `randomNonce()` from
   `attest/attestation.ts`) and fetches the **TD quote** from the enclave, bound via
   `report_data = SHA-256(enclave_ephemeral_pubkey ‖ nonce)`. The ephemeral keypair is
   generated *inside* the VM and its private half never leaves enclave memory.
3. **Verify (client-side, the trust decision).**
   - Validate the quote chain to Intel roots (DCAP / PCS, or Azure MAA / GCP attestation as
     the verifier backend). *This is stricter than the current inference check* — for the
     agent host we control the image, so we do **full quote verification**, not the
     "pragmatic" NEAR check that defers to an external verifier.
   - **Pin the measurement** (`MRTD` + config RTMRs) against the expected value for the
     published Harbor image. This is the step that proves it's *our audited agent*, not a
     tampered or swapped image. Mismatch ⇒ hard fail, refuse to proceed.
   - Confirm the nonce is echoed (freshness / anti-replay) and bind `enclave_pubkey`.
4. **Seal.** Client seals the session package — provider API keys (if BYOK), the repo/workspace,
   any secrets — to `enclave_pubkey` using the existing sealed-box (`sealJson` /
   `outboxSeal.ts`). Only code running inside the measured enclave holds the private key to
   open it. The Privateer server relays the ciphertext but can't read it.
5. **Drive.** Client opens the relay as `controller`; the enclave harbor connects as `agent`
   (existing `routes/relay.js` ticket flow). From here it's the *current* remote-access
   experience, just pointed at a server instead of a laptop — including the per-tool
   **permission gate**, which is now load-bearing (§6).

Client library: extend `pi-privacy` with `attest/harbor.ts` (quote fetch + verify +
measurement pin). The CLI gains a `/cloud` (or `harbor`) command; the portal calls the same
verify logic in TS. **Verification must live client-side in code the user can read** — a
server-side "we checked it for you" defeats the entire point (cf. the 3e805db lesson:
"Don't let server-proxied posture reach tee-verified").

---

## 4. Honest-labeling: the ladder gets a new rung

`posture/tiers.ts` currently grades where **inference** happens. Harbor introduces where the
**runtime** happens. Do **not** paper over the difference — the credibility of the whole
package rests on the verified/asserted distinction.

Add a runtime-attestation dimension (sketch):

- `harbor-verified` — enclave quote validated to Intel roots **and** measurement matched the
  published image. `verifiability: "cryptographic"`, `posture: "green"`. Blurb states the
  residual trust explicitly (§6).
- `harbor-unverified` — a cloud agent is running but attestation was incomplete or the
  measurement didn't match/couldn't be pinned. `posture: "yellow"`, treat as untrusted.
- The composite session badge shows **both** rungs: runtime tier × inference tier. A fully
  green session is `harbor-verified` runtime **and** `tee-verified` inference. Anything less
  is labeled honestly.

Publish the expected measurement + reproducible build recipe in the **transparency mirror**
(the project already runs one). Then a green badge is checkable by anyone against open source,
not just asserted by us. That's the strongest version of the claim.

---

## 5. Build phases & effort

**Phase 0 — vertical spike (~1 week).** One Azure or GCP TDX CVM, booted with `harbor/index.ts`
inside it. Get a real TD quote, verify it client-side against a hand-pinned measurement, open
the existing relay from inside the VM, drive it from the CLI. Proves the entire trust chain
minus provisioning UX and multi-tenancy. **This is the go/no-go.**

**Phase 1 — MVP (a few weeks after Phase 0).**
- Provisioner service: one CVM **per session/user** (single-tenant-per-VM ⇒ hard isolation for
  free; sidesteps the multi-tenant-sandbox problem entirely for v1). Lifecycle: boot / attach /
  stop; idle-reap.
- Attested bootstrap (§3) as real client code in `pi-privacy` + a `/cloud` CLI command.
- **Ephemeral** workspace: client `git push`es the repo in over the attested channel each
  session; nothing persists on our disks. Sidesteps encrypted-volume work.
- Billing: add a compute line item next to `AGENT_CLI_MARKUP_FACTOR`.
- Minimal web console: sign in, pick model + size, start/stop, attach (reuse portal auth).

**Phase 2 — product (the "match the tweet" milestone, ~a couple months total).**
- Persistent **encrypted workspaces**: volume DEK sealed to the enclave measurement, re-released
  on re-attest across restarts; fast idle-suspend/resume.
- **Org layer**: teams, seats, RBAC ("granular access controls"), usage rollup ("unified
  billing"). Some billing plumbing reuses; RBAC + console UI are new.
- Reproducible image builds + published measurement in the transparency mirror.
- Optional: in-house **GPU-CC** model hosting (H100 CC) to own the inference link too.

Rough sizing: internal MVP that reuses relay + billing and runs the harbor in a real TDX VM
is **weeks**; the org product matching Nous is **~a couple months**, dominated by
provisioning/lifecycle and the encrypted-persistence + RBAC work — *not* by the crypto, which
largely exists.

---

## 6. Threat model & residual trust (put this in the green-badge blurb — don't overclaim)

**Harbor-verified protects against:** the operator (Privateer/host) reading prompts, code,
keys, or model I/O from VM memory (TDX memory encryption); the operator silently swapping the
agent for a modified image (measurement pin fails at the client); replay of a stale quote
(nonce binding).

**It does NOT protect against, and the blurb must say so:**
- **Availability / censorship / scheduling** — the operator can still deny or delay service.
- **Traffic analysis** — egress destinations, timing, and sizes are visible at the network
  edge unless separately mitigated. Consider constrained/audited egress from the enclave.
- **The trust root** — you are trusting Intel's attestation PKI and CPU microcode, and the
  reproducibility of our image build. TEEs have a side-channel history; this is "verified,"
  not "unbreakable."
- **What the agent is *told* to do** — a prompt-injected or misbehaving agent runs on our
  infra. The **per-tool permission gate** (`src/permissions`, `ext/permissionGate.ts`) and the
  headless `SAFE_TOOLS` restriction go from "nice" to **existential** here: destructive shell
  must fail-closed, egress must be gated. Single-tenant-per-VM (Phase 1) contains blast radius
  to the user's own session; multi-tenant packing (if ever) reintroduces a hostile-sandbox
  problem and must not ship without microVM isolation.

The honest one-liner, in the `tiers.ts` house style:
> *"Confidential cloud agent, cryptographically verified: the client attested genuine TDX
> hardware and pinned the running image before sending your code or keys — the operator can't
> read this session's memory. Does not cover availability or network-timing metadata; trust
> root is Intel's attestation PKI + our reproducible image."*

---

## 7. Open questions

1. **Verifier backend**: raw DCAP/PCS (most control, most work) vs Azure MAA / GCP attestation
   (fastest to a real quote pipeline). Recommend MAA-backed for Phase 0, keep the client-side
   measurement pin regardless of backend.
2. **Cloud host**: Azure Confidential VMs (mature TDX + MAA) vs GCP Confidential VMs vs
   bare-metal + Kata/Firecracker+TDX. Phase 0 should just pick the fastest real TDX quote.
3. **Persistence key custody**: measurement-sealed volume DEK (survives restart, but a rebuilt
   image rotates the measurement → migration story) vs client-held key re-sealed each session
   (simpler, but no unattended resume). Leaning client-held for MVP.
4. **Naming/positioning of the tier** so it never reads like the inference tier.
5. **Model link**: mandate TEE-attested inference from inside the enclave for a fully-green
   session, or allow BYOK-to-any-provider with the inference rung honestly downgraded?
