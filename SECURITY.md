# Security

## Reporting a vulnerability

Report privately via [GitHub Security Advisories](https://github.com/privateer-agent/privateer-agent/security/advisories/new),
or email **support@privateer.pro**. Please don't open a public issue for anything
exploitable. Expect an initial response within 72 hours.

## What you're running

Privateer is a terminal coding agent: it reads and writes files, runs shell commands and
talks to model providers on your behalf. That is the point of it, and it is also the
threat model. Two things are worth verifying rather than taking on faith.

**The package runs no install scripts.** There is no `preinstall`, `install`,
`postinstall` or `prepare` hook. `npm install -g privateer-agent` writes files and
executes nothing; installing with `--ignore-scripts` produces an identical result. Code
runs only when you run `privateer`. (Dependency patching happens at first launch — see
`bin/apply-patches.mjs` and `docs/shipping.md`.)

**Releases carry npm provenance.** Published from `.github/workflows/release.yml` with
`npm publish --provenance`, so npm holds a signed Sigstore attestation binding the
tarball to this repository, the exact commit and the workflow run that built it. The npm
package page shows a verified *"Built and signed on GitHub Actions"* badge linking to
the build. To check it yourself:

```bash
npm view privateer-agent dist.attestations   # attestation metadata exists
npm audit signatures                          # verifies registry signatures + provenance
```

If a version lacks provenance, it did not come from this workflow. Treat that as
suspicious and report it.

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
`docs/daemon-channels-and-app.md`.
