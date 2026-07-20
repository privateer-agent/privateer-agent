# Shipping Privateer — self-contained bundles

Goal: a user installs Privateer with **no Node and no npm** — just a terminal and
internet. We do that by shipping a per-platform *bundle* (a pinned Node runtime +
the fully-installed, patched, prod-only app tree) that the installer downloads and
unpacks. This replaces the old `npm install -g privateer-agent` default (still
supported as a power-user path).

## Why a bundle, not a single-file binary

`privateer` is not a single program we can `--compile`:

- Pi's `cli.js` is the **host** process; our moat loads via **filesystem discovery**
  of `.ts` shims dropped into `~/.privateer/agent/extensions/` (see `bin/privateer-tui`).
- Subagents **spawn child `node` processes** pointed back at that on-disk `cli.js`.
- `patch-package` rewrites files **inside `node_modules`** (at first launch, not install).
- 29 native `.node` addons (`koffi`, `pi-tui`) force a per-(os,arch) artifact anyway.

A bundle preserves the exact on-disk layout all of that depends on. Pi's bundled
`jiti` transpiles the `.ts` moat at runtime, so the TUI path needs no `tsx`.

## Layout

```
privateer-<os>-<arch>/
├── node (node.exe)    # pinned Node 22.19.0
├── node_modules/      # prod-only, patch-package applied, ONE platform's natives
├── src/  extensions/  # app code (loaded as-is; jiti/tsx handle .ts)
├── bin/               # privateer-launch.mjs (shared logic) + platform shims
│                      #   privateer-tui  (unix bash shim → picks node → launch.mjs)
│                      #   privateer.cmd  (Windows shim → node.exe → launch.mjs)
│                      #   privateer-daemon.mjs, privateer-subagent.mjs
├── package.json  patches/  README.md  LICENSE
└── BUNDLE_INFO.json   # { target, node, version, channel:"bundle" } — launcher marker
```

### Launcher

`bin/privateer-launch.mjs` is the **single, cross-platform** source of launch logic
(moat-shim install, settings defaults, model pick, update/daemon dispatch, exec into
Pi's TUI). Two thin shims just pick a Node and run it:

- **unix** `bin/privateer-tui` (bash) — bundled `./node` wins, else system node ≥22, else nvm.
- **Windows** `bin/privateer.cmd` — runs `..\node.exe privateer-launch.mjs %*`.

The launcher detects `BUNDLE_INFO.json` + the bundled node, uses that runtime, and
prepends the bundle dir to `PATH` so child `#!/usr/bin/env node` processes (Pi's cli,
the subagent wrapper) resolve it too. The moat shims re-export their targets as
`file://` URLs (portable across OSes; verified to load via Pi's `jiti`).

## Build

`scripts/build-bundle.mjs` builds one target (or `--all`):

```
node scripts/build-bundle.mjs --target darwin-arm64
```

It downloads the pinned Node binary from nodejs.org, runs
`npm ci --omit=dev --os=<os> --cpu=<arch>` then applies patches explicitly (the
package has no postinstall — see "Install-time execution" below),
prunes cross-platform natives down to the target, copies app code, and produces
`dist-bundle/privateer-<target>.tar.gz(+.sha256)` (`.zip` for Windows).

**Any host can build any target.** koffi/pi-tui bundle all platforms in one package
(pruned per target), and `--os`/`--cpu` make npm fetch the *target's* os/cpu-gated
optional deps (`@mariozechner/clipboard-<plat>`, `fsevents`) instead of the build
host's — so cross-building is faithful. The prune walks **all** copies of a native
package in the tree (npm nests duplicates), not just the top level.

## Release (CI)

`.github/workflows/release.yml` — push a `v*` tag → all targets build in parallel on
one Ubuntu runner (cross-build via `--os/--cpu`), the Linux bundle is boot smoke-tested
inline and the **Windows bundle is boot smoke-tested on a `windows-latest` job**, then
`publish` attaches every archive + checksum to the GitHub Release. Installers pull from
`releases/latest/download/`. A manual `workflow_dispatch` builds without publishing.

The `publish` job sets **`GH_REPO`** because it downloads artifacts without checking out
the repo, so `gh` has no git remote to infer from. Without it every `gh release upload`
died with `fatal: not a git repository` — which is exactly what happened from v0.6.2
through v0.6.5: the releases were created, the bundles built, and **every release ended
up with zero assets**, so `curl https://privateer.pro/install.sh | sh` 404'd for months
while the failure sat unnoticed in a red CI job. A follow-up step now asserts all four
bundles are attached, so an empty release fails the run instead of shipping quietly.

`publish-npm` then publishes to npm with **`--provenance`**, authenticated by **npm
trusted publishing (OIDC)** — there is no npm token in this repo and none should be
added. npmjs.com is configured to trust this repo + **this workflow filename**, so
renaming `release.yml` breaks publishing until the Trusted Publisher entry is updated to
match. Needs `id-token: write` (granted at the workflow level) and npm ≥ 11.5.1, which is
why the job upgrades npm over the one Node 22.19.0 ships.

The job refuses to publish when the tag and `package.json` version disagree, so a
mistagged push can't launder an unreviewed build through this workflow's provenance.
Publishing by hand from a laptop produces no attestation and should not be done — cut a
tag instead.

## Install

Both installers download + verify the bundle, unpack to `<home>/app`, put a launcher
on PATH, and support `privateer update` (re-download). Neither needs Node or npm.

- **macOS / Linux:** `curl -fsSL https://privateer.pro/install.sh | sh`
  → `~/.privateer/app`, symlink `~/.privateer/bin/privateer`, PATH via shell rc.
- **Windows:** `irm https://privateer.pro/install.ps1 | iex`
  → `%USERPROFILE%\.privateer\app`, a `privateer.cmd` shim in `…\.privateer\bin`, PATH
  via the user environment. (`npm install -g privateer-agent` remains a power-user path.)

## Pending

1. **linux-arm64 / win32-arm64.** Not yet in the release matrix. Cross-build works
   (`--os/--cpu`), so it's just adding the targets + Node dist URLs; `install.ps1`
   already falls back arm64→x64 under emulation until a native arm64 build exists.
2. **Real Windows human-test.** CI boot-tests the win bundle on `windows-latest`, and
   the launch logic is shared+verified on unix, but a human run-through on Windows
   (interactive TUI, subagent spawn, clipboard) hasn't happened yet.
3. **Size** — now ~113 MB compressed / ~430 MB unpacked (was ~145 / ~718). The build
   slims runtime-dead weight: `.dSYM` debug symbols (a mis-published `hypa.dSYM` was
   ~102 MB), source maps (~105 MB), and `.d.ts` declarations (~80 MB). Remaining fat is
   the Node runtime (~109 MB) and provider SDKs. Further options, not yet done: drop
   `tsx` + `@esbuild` (~12 MB — needs the daemon/REPL launchers moved off `tsx/esm/api`
   to `jiti`, which risks the daemon boot); drop `recheck` jar+native (~49 MB, if truly
   unused at runtime); `strip` the Node binary (risky re: macOS signing).
4. **In-app `/update` still assumes npm.** `bin/privateer-tui`/`privateer-launch.mjs`
   handle `privateer update` bundle-aware (re-run the installer), but the `/update`
   command inside the app (`extensions/privateer-brand.ts`, ~line 327) still shells
   `npm install -g privateer-agent@latest`, which fails on a bundle install. Make it
   detect `BUNDLE_INFO.json` and re-run the installer instead (the startup banner's
   "run privateer update" hint is already correct — it points at the launcher).

## Done

- **`--version` reports Privateer's version** (was Pi's `0.80.3`). The launcher now
  intercepts `--version`/`-V` and prints `privateer <ourVersion> (pi <piVersion>)`
  from `package.json`, before ever reaching Pi's `cli.js`. (The startup banner already
  read the correct version from `package.json`, so the update-banner compare was fine.)

## Install-time execution (and why there is none)

The package deliberately declares **no `preinstall`/`install`/`postinstall`/`prepare`
script**. `npm install privateer-agent` writes files and runs nothing; you can verify
with `--ignore-scripts` and see identical results. A test in `tests/applyPatches.test.ts`
fails the build if a hook is ever reintroduced.

This matters for two reasons.

**Trust.** A brand-new package from a single maintainer has no reputation to trade on.
Install-time code execution is the thing a careful reviewer — increasingly, a *coding
agent* asked to run `npx privateer-agent` — flags first, and it is the one signal we can
remove outright rather than argue about. What's left is `npm publish --provenance` from
the release workflow: npm records a Sigstore attestation binding the published tarball
to this repo, commit and workflow run, so the code on the registry is checkably the code
in the public repo. Neither of these asks anyone to trust a maintainer's laptop.

**It was actively broken.** The old `postinstall` ran `patch-package --error-on-fail`
with cwd = the package directory. npm only *nests* dependencies there for a global
install; `npx privateer-agent` and `npm i privateer-agent` **hoist** them to a parent
`node_modules`. patch-package therefore found nothing to patch, exited non-zero, and npm
aborted the entire install — with no output at all. `npx privateer-agent` (the headline
command in the README) failed for every user from 0.6.x until this was fixed.

Patching now happens in `bin/apply-patches.mjs`, called from the launcher on a run the
user actually asked for. It is stamped (`node_modules/.privateer-patches.json`, keyed by
a hash of the patch set) so it costs one file read per launch after the first, and it is
**best-effort**: both patches are UX fixes, so a root-owned `node_modules` from a
`sudo npm i -g` degrades to stock Pi behaviour with a printed explanation instead of a
failed boot.

The same fix applies to dependency resolution generally. `findDepRoot`/`resolveDep` walk
the `node_modules` chain rather than assuming `<repo>/node_modules`, because that path
only exists in the global-install layout — the launcher's shim and `cli.js` paths had the
identical latent bug, masked by the install failing first.
