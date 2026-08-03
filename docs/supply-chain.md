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
