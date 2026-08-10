# Supply-chain policy

How Privateer defends against npm supply-chain attacks — in both directions:
what we do so that *installing our packages* is safe, and what we do so that
*the dependencies we install* can't compromise the code we ship. The
public-facing version of this document (what users can verify, and how) lives
in the transparency repo at `docs/SUPPLY_CHAIN.md`.

## Threat model

The npm attacks that actually happen, and which control stops each:

| Attack | Example | Our control |
|---|---|---|
| Malicious install script runs on `npm install` | `event-stream`-era droppers, most 2023–25 malware waves | `ignore-scripts=true` in `.npmrc`, `--ignore-scripts` in CI |
| Good package turns bad in a later version | `ua-parser-js`, `node-ipc` | exact pins + committed lockfile + `npm ci`; Dependabot cooldown |
| Registry tarball ≠ repo source | maintainer-laptop or token-theft publishes | npm **trusted publishing** + `--provenance` for our own packages; `npm audit signatures` over our dep tree in CI |
| Long-lived publish token stolen | CI secret exfiltration | there is **no npm token anywhere** — OIDC mints a per-run credential |
| User's machine compromised at install time | any of the above, on the user's side | bundles: users install a bit-for-bit release artifact, not a dependency graph; the npm package has **no install scripts** |

## What is enforced, and where

### 1. No install scripts (`ignore-scripts=true`)

Per-repo `.npmrc` sets `ignore-scripts=true` in **privateer-agent**,
**pi-privacy**, **pi-workflow**, and **treeview/server** (Render's `npm ci`
build picks the file up, so prod builds get it too). This is the single
highest-value control: it neuters the most common payload delivery — code
execution at install time, before you've run anything.

It is safe here because every dep that declares a hook works without it:

- **koffi** — ships prebuilt binaries for every platform inside the package
  (`build/koffi/<platform>/`); its install script is only a build-from-source
  fallback.
- **esbuild** — the platform binary arrives as an optional dependency
  (`@esbuild/<platform>`); postinstall is a fallback check.
- **protobufjs** — postinstall prints a compatibility warning.
- **aws-sdk** (server) — postinstall prints a maintenance-mode warning.
- **msgpackr-extract** (server) — loads prebuilds at runtime via optional
  platform packages, with a pure-JS fallback.
- `prepare` scripts never run for registry installs, only for git deps and the
  root package — so the long tail of `prepare` entries is irrelevant.

privateer-agent itself has **no install scripts by design**: dependency
patches apply at *launch* (`bin/apply-patches.mjs`), never at install. That is
also what makes `npx privateer-agent` work under a consumer's own
`ignore-scripts=true` (and what broke `npx` back in 0.6.x when a postinstall
still existed — see the npm-trust history in the repo).

**Documented exceptions** (each carries an explanatory `.npmrc`):

- **treeview/client** — its own postinstall runs `patch-package` (the RN
  native patches must apply at install), and React Native/Expo deps need
  their hooks.
- **treeview/desktop** — Electron's install script is what downloads the
  Electron binary.

In the exception dirs, any **new** dep that adds an install script is a review
flag, not business as usual.

### 2. Exact pins, lockfile installs, upgrade cooldown

- `save-exact=true` in every `.npmrc`: new deps land exactly pinned; version
  movement is a deliberate, reviewable lockfile diff.
- CI and Render install with `npm ci` (never bare `npm install`), so the
  committed lockfile — with its per-package integrity hashes — is the source
  of truth.
- `.github/dependabot.yml` applies a **cooldown**: 7 days minimum age before
  any release is proposed, 14 for majors. Nearly all npm malware is caught and
  unpublished within days of publish; a cooldown means the ecosystem steps on
  the mine before we do.
- **Every direct dependency is pinned exactly in the published
  `package.json`** — not just in our lockfile.

That last point is a distinction worth spelling out, because for a long time we
had the first three and quietly lacked the fourth. `save-exact`, `npm ci` and
the cooldown protect **our** builds: the lockfile is the source of truth for CI
and for the bundles. None of them reach a user running `npm i -g
privateer-agent`, because **npm ignores a dependency's lockfile**. With caret
ranges in the manifest, that install resolved ~500 packages live, adopting any
matching release the moment it appeared — no cooldown, no review, no lockfile.

The gap was not theoretical. A fresh install of 0.12.8 on 2026-08-10 resolved
`@earendil-works/pi-ai` and `pi-tui` to **0.80.10** against a `pi-coding-agent`
pinned at 0.80.3, and `@juicesharp/rpiv-ask-user-question` to **2.4.0** where
2.2.0 was tested. Exact pins in the manifest close it for direct dependencies
(transitives still float — see "What this does not solve"), and make drift
detectable: `privateer verify` compares each resolved version against its pin.

### 3. Publishing: provenance, no tokens

`release.yml` publishes to npm via **trusted publishing** (OIDC): npmjs.com
trusts exactly this repo + this workflow file, a short-lived credential is
minted per run, and there is deliberately no `NODE_AUTH_TOKEN` to leak or
rotate. `npm publish --provenance` records a signed Sigstore attestation
binding the published tarball to this public repo, commit, and workflow run —
the npm package page shows the verified "Built and signed on GitHub Actions"
badge linking back to the build. A stolen maintainer laptop cannot publish
what CI didn't build.

Guard rails around it, all in `release.yml`:

- the publish install runs `--ignore-scripts` (proving the package installs
  clean for consumers who do the same);
- `npm audit signatures` verifies registry signatures and provenance
  attestations for the **entire installed dep tree** before anything is
  published from it;
- the git tag must equal `package.json` version, so a mistagged push can't
  publish unreviewed code under a reviewed tag's provenance;
- releases fail loudly if any platform bundle is missing.

### 4. Bundles: users don't run npm at all

The primary install path (`privateer.pro/install.sh` / `install.ps1`)
downloads a self-contained per-platform bundle from a GitHub release — pinned
Node runtime plus a vendored, already-resolved `node_modules`. Users never
execute a dependency resolution, never run an install script, and get the same
bytes CI smoke-tested. That removes the entire class of install-time attacks
from the user's machine. See `docs/shipping.md`.

The bundle is the path we *recommend*, so it must not be the least verifiable
one. Two controls, both added 2026-08-10:

- **The installers fail closed.** `install.sh` / `install.ps1` fetch the
  release's published `.sha256` and refuse to install on a mismatch, on a
  missing digest, or on a machine with no way to compute one. Previously all
  three of those cases silently installed anyway — the verification was
  best-effort, and the two failure modes that actually matter (no checksum
  served, no hashing tool) both took the quiet path.
  `PRIVATEER_SKIP_CHECKSUM=1` overrides, loudly.
- **The bundles are attested.** A checksum served from the same origin as the
  file it describes proves integrity, not provenance: whoever can swap one can
  swap both. `release.yml` now runs `actions/attest-build-provenance` over
  every archive, so each bundle's digest is bound by a signed Sigstore
  statement to this repo, commit and workflow run — the same guarantee npm
  provenance gives the tarball. The installers verify it automatically when
  `gh` is present, and anyone can check by hand:

  ```bash
  gh attestation verify privateer-darwin-arm64.tar.gz \
    --repo privateer-agent/privateer-agent
  ```

  Note for whoever next touches that code path: `gh` reports a *missing*
  attestation as a bare `HTTP 404`, not as anything containing the words "no
  attestation". Treating 404 as a verification failure would abort every
  install of a release cut before this landed.

### 5. Checkable after the fact: `privateer verify` and an SBOM

Every control above is an install-time signal, which is no use to someone
asking "is this still what you published?" weeks later. Two answers ship for
that:

- **`privateer verify`** (`bin/privateer-verify.mjs`) reads the install on
  disk: its shape (bundle vs npm), whether this exact version is published and
  carries a provenance attestation, whether any direct dependency drifted from
  its pin, and which launch-time patches are applied. It reports "verified",
  "failed" and "couldn't check" as three distinct outcomes and never renders
  the third as the first; inconclusive checks do not set a failing exit code,
  so it is safe in CI. It is **not a security boundary** — anything that can
  rewrite `node_modules` can rewrite the checker — but nearly all real
  breakage is accidental, and it catches that.
- **A CycloneDX SBOM** is attached to every release and attested alongside the
  bundles (~450 components). When an advisory lands against something
  transitive, anyone can determine whether a given release was affected
  without waiting for us to say so.

### 6. Known concentration risk: `@juicesharp/*`

`@juicesharp/rpiv-ask-user-question` and `@juicesharp/rpiv-web-tools` are Pi
extensions we depend on directly, and they sit on two of the most sensitive
paths in the agent: the prompt the user is asked to answer, and web fetch.
Audited 2026-08-10:

- **Good:** MIT, public source (`github.com/juicesharp/rpiv-mono`), no install
  scripts, a tiny transitive surface (`@juicesharp/rpiv-config`, `typebox`),
  and real adoption beyond us (~17k weekly downloads for the questionnaire).
- **Risk:** a **single maintainer**, **no npm provenance**, published from an
  account rather than a trusted publisher, at a fast cadence (111 versions
  since April 2026). We cannot verify that a given tarball matches that repo.

Mitigation today is the exact pin plus the cooldown: a new release is adopted
deliberately, not automatically. If these ever need to move faster than we can
review them, vendoring is the answer, not a caret.

## Checklist: adding a dependency

1. Is it worth a dependency at all? Check the transitive weight
   (`npx howfat <pkg>`); a 5-line utility is not worth 40 new maintainers.
2. Does it declare `preinstall`/`install`/`postinstall`? If yes, confirm it
   works under `ignore-scripts` (prebuilds in-package or optional platform
   deps) — or don't take it.
3. Does it have npm provenance (the badge)? Prefer packages that do.
4. Is the version at least a week old? If not, wait — that's the same
   cooldown Dependabot applies.
5. Install normally (`npm i pkg` — `.npmrc` pins it exactly) and commit the
   lockfile diff after actually reading it.

## What this does not solve

- A dependency can still be malicious **at require time** — `ignore-scripts`
  stops install-time execution, not runtime behavior. Pins + cooldown + small
  dep surface reduce, not eliminate, that risk. Runtime capability confinement
  (LavaMoat-style) is the known next step if the threat warrants the cost.
- Provenance proves *where a package was built from*, not that the source is
  benign. It converts "trust the publisher's laptop" into "audit the public
  repo", which is the point of the transparency mirror — but someone still has
  to read the code.
- **Transitive dependencies still float on the npm install path.** Pinning the
  manifest fixes our ~24 direct dependencies; the other ~425 packages resolve
  from their parents' ranges. Bundle users are unaffected (the tree is
  vendored, already resolved). Closing this for npm users too would mean
  shipping a lockfile npm actually honours — which, for a dependency, it does
  not. The honest recommendation for anyone who wants a fixed tree is the
  bundle.
- **`npm i -g` still runs dependency install scripts** on a default npm
  config. `ignore-scripts=true` in our `.npmrc` governs *our* installs, not a
  user's: seven packages in the resolved tree declare hooks (`esbuild`,
  `koffi`, `fsevents`, `protobufjs` ×2, `@google/genai` ×2). None are needed,
  which is why `README.md` and `SECURITY.md` document
  `npm install -g privateer-agent --ignore-scripts` as the install we test.
  Wording that implies otherwise is a claims bug — it is trivially falsifiable
  and it is exactly the sort of thing this project cannot afford to get wrong.

## Advisory status

Cleared 2026-08-10: **10 vulnerabilities (2 high) → 2 low.**

- The five `undici` advisories (response desynchronisation, cross-user
  information disclosure, CRLF injection, cookie-attribute injection) came from
  `undici` 8.0.0–8.8.0 nested under `@earendil-works/pi-coding-agent` 0.80.3.
  Fixed by upgrading pi to **0.84.1**, which ships `undici` 8.9.0.
- Our own top-level `undici` was **also** affected and had been miscounted as
  clean — 7.28.0 falls inside the vulnerable 7.x range. Pinned to 7.29.0.
- `npm audit fix` cleared the remaining transitive highs (`fast-uri`,
  `ip-address`) and the `hono` moderates without touching a direct pin.

What remains is 2 low (`@phala/dcap-qvl` → `elliptic`), where the only offered
"fix" is a semver-major **downgrade** of dcap-qvl. Not taken.

Worth recording, since it looks like an easy out: an `overrides` block in our
own `package.json` would NOT have fixed this for npm users. npm reads
`overrides` only from the root project, and a globally-installed package is not
the root — verified empirically. The bundles would have been covered and `npm
i -g` users would not, which is the worse half of the audience to protect.

## Open

- Nothing tracked. See the pi-0.84 migration note in `docs/pi-migration-plan.md`
  for the credential-store change that upgrade required.
