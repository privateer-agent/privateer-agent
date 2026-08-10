# Security

## Reporting a vulnerability

Report privately via [GitHub Security Advisories](https://github.com/privateer-agent/privateer-agent/security/advisories/new),
or email **support@privateer.pro**. Please don't open a public issue for anything
exploitable. Expect an initial response within 72 hours.

## What you're running

Privateer is a terminal coding agent: it reads and writes files, runs shell commands and
talks to model providers on your behalf. That is the point of it, and it is also the
threat model. Two things are worth verifying rather than taking on faith.

**This package runs no install scripts.** There is no `preinstall`, `install`,
`postinstall` or `prepare` hook in `privateer-agent`: nothing we publish executes at
install time, and installing with `--ignore-scripts` produces an identical result. Our
code runs only when you run `privateer`. (Dependency patching happens at first launch —
see `bin/apply-patches.mjs` and `docs/shipping.md`.)

That is a claim about *our* tarball, not about your whole install, and the difference
matters. `npm install -g privateer-agent` resolves a tree of roughly 500 packages, and
seven of them do declare install scripts — `esbuild`, `koffi`, `fsevents`, `protobufjs`
(×2) and `@google/genai` (×2). On a default npm config those execute on your machine, as
they would for anything else that depends on them. Every one is a build-from-source or
compatibility-warning fallback we don't need, so install with scripts off:

```bash
npm install -g privateer-agent --ignore-scripts
```

That is the install we test and the shape CI publishes from, and it produces a working
`privateer`. To skip the dependency graph altogether, use a release bundle
(`curl -fsSL https://privateer.pro/install.sh | sh`): a fixed set of files with a pinned
Node, no resolution step on your machine at all.

**Releases carry npm provenance.** Published from `.github/workflows/release.yml` with
`npm publish --provenance`, so npm holds a signed Sigstore attestation binding the
tarball to this repository, the exact commit and the workflow run that built it. The npm
package page shows a verified *"Built and signed on GitHub Actions"* badge linking to
the build. To check it yourself:

```bash
npm view privateer-agent dist.attestations   # attestation metadata exists
npm audit signatures                          # verifies registry signatures + provenance
```

**You can re-check the install later.** Everything above is an install-time signal, which
is not much use to someone asking the question weeks afterwards. `privateer verify` reads
the install actually on disk and reports the shape it took, whether this version is
published with provenance, whether any dependency has drifted from its pinned version,
and which launch-time patches are applied. It distinguishes "verified" from "couldn't
check" and never reports the second as the first. It is not a security boundary — anything
that can rewrite `node_modules` can rewrite the checker — but it catches the accidental
and opportunistic cases, which is nearly all of them.

**Bundle downloads are verified before they unpack.** `install.sh` / `install.ps1` fetch
the release's published SHA-256 and refuse to install on a mismatch, a missing digest, or
a machine with no way to compute one (`PRIVATEER_SKIP_CHECKSUM=1` overrides, loudly). A
checksum served from the same origin as the file proves integrity but not provenance, so
from the release following this change the bundles also carry a GitHub build attestation,
which the installers verify automatically when `gh` is available:

```bash
gh attestation verify privateer-darwin-arm64.tar.gz --repo privateer-agent/privateer-agent
```

If a version lacks provenance, it did not come from this workflow. Treat that as
suspicious and report it — with one documented exception: **0.6.7 is the first release
published this way.** Trusted publishing was misconfigured until then, so every earlier
version (through 0.6.6) was published by hand from a maintainer's machine and carries no
attestation. Those are not forgeries, but they are not independently verifiable either.
If that distinction matters to you, use 0.6.7 or later.

## The permission gate

By default every shell command, file write outside the working directory, and
destructive tool call stops for explicit approval. This is the moat, and it is the main
thing standing between a prompt-injected model and your filesystem.

`--no-quarter` disables it entirely — every action runs unprompted. It exists for
trusted, disposable environments (throwaway containers, CI). Do not use it on a machine
whose contents you care about, and do not use it on a repository or task involving
untrusted content: a coding agent reading an attacker-controlled file is a realistic
injection path.

## Keys and credentials

Provider API keys and account credentials live under `~/.privateer/` on your machine and
are sent only to the provider you selected. Bot tokens for messaging channels are sealed
to a terminal keypair before they reach our relay, and channel configuration is verified
against a link-pinned account key — the relay can neither read those tokens nor forge
configuration. Architecture and residual risks are documented in
`docs/harbor-channels-and-app.md`.
