# Project config dirs: `.privateer/` and `.pi/`

A project can configure Privateer in **`.privateer/`**. Pi's own **`.pi/`** keeps working,
both are read, and `.privateer` wins every conflict.

```
<project>/
  .privateer/        # Privateer's project config — read first, written to
    settings.json
    skills/ prompts/ themes/ extensions/
    SYSTEM.md  APPEND_SYSTEM.md
    npm/ git/         # package payloads
  .pi/               # stock Pi's project config — still read, never written to
    ...same layout
```

## Why this needs a patch

Pi resolves every project-scoped path as `<cwd>/CONFIG_DIR_NAME/…`, where
`CONFIG_DIR_NAME` is a **build-time constant** read from pi-coding-agent's own
`package.json` (`piConfig.configDir`, default `".pi"`). There is no env var and no
settings key for it — `PI_CODING_AGENT_DIR` moves only the **user** dir, which is why
`~/.privateer/agent` works today while every project still had to spell its config
`.pi/`, a directory named after a tool that isn't installed on a Privateer machine.

Renaming the constant (via `piConfig`, Pi's documented fork hook) was the cheap option
and the wrong one: it orphans every existing `.pi/` folder and breaks interop with stock
Pi in shared repos. So both names are live instead, implemented in
`patches/@earendil-works+pi-coding-agent+<version>.patch`.

## Semantics

| Surface | Behaviour |
|---|---|
| `settings.json` | Deep-merged per key: `.pi` first, `.privateer` layered on top. Nested objects merge; arrays and primitives are replaced wholesale (same rule Pi already uses for global → project) |
| `skills/`, `prompts/`, `themes/` | Union of both dirs. On a name collision the `.privateer` copy wins and the `.pi` one is reported as a normal collision diagnostic |
| `extensions/` | Union, but a `.pi` file whose **basename** matches one in `.privateer` is skipped — otherwise the same extension would load twice |
| `SYSTEM.md`, `APPEND_SYSTEM.md` | First one found wins: `.privateer`, then `.pi` |
| `npm/`, `git/` payloads | Looked up in both dirs; a new download goes to whichever dir already has a payload tree, else `.privateer/` |
| Project trust | Prompted if **either** dir holds trust-requiring resources |
| Writes (`install -l`, `remove -l`, `/settings` project scope) | Always `.privateer/settings.json`, created if absent |

Writes are **reduced against the inherited base**: only keys that actually differ from
`.pi/settings.json` are persisted, so `.privateer` holds this project's overrides rather
than a snapshot of `.pi` that would silently diverge later. `.pi/` is never written to.

### Known limits

- **A key can be overridden but not un-set.** Deleting it from `.privateer` lets `.pi`'s
  value show through again. (Stock Pi's global → project layering has the same limit.)
- **Arrays replace, they don't concatenate.** A `packages` array in `.privateer`
  supersedes `.pi`'s entirely — which is how `remove -l` of a `.pi`-declared package
  works: `.privateer` gets the reduced array.
- **Relative entries** (`"./local-pkg"`) are relative to the settings file that declared
  them, but the merged scope has one base. `resolvePathFromBase` falls back through the
  other project dirs and takes the first path that exists, so a `.pi`-relative entry
  still resolves once `.privateer/` appears. Absolute entries are unaffected.

## Maintenance

Unlike the rest of the patch set — UX fixes that degrade to stock Pi if they don't apply
— **this one is load-bearing**: an unapplied patch means a project's `.privateer/` is a
directory Pi has never heard of and its config is ignored outright.
`bin/privateer-launch.mjs` therefore warns on a failed apply, and says so much louder
when the current project actually has a `.privateer/`.

On a pi-coding-agent version bump:

1. Re-apply the edits to the new `dist/` (the seams are `config.js`
   `PROJECT_CONFIG_DIR_NAMES` + helpers, and every former `CONFIG_DIR_NAME` consumer
   outside the user-dir paths).
2. `node node_modules/patch-package/index.js @earendil-works/pi-coding-agent`
3. `node --import tsx --test tests/projectConfigDirs.test.ts` — that suite is the guard
   that catches the feature quietly reverting to `.pi`-only.

The right long-term fix is upstream: a `piConfig.configDirs` **array** instead of a
single `configDir`. Pi already exposes the fork hook; this is the same idea with
precedence.
