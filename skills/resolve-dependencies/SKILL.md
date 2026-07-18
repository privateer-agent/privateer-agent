---
name: "resolve-dependencies"
description: "Resolve a missing system binary/CLI tool or language package (npm/pip/cargo/go/gem) in the current environment. Use when a command fails with 'command not found', a build/test fails on a missing tool, or code fails on an unresolved import/module. Detects the right package manager, prefers a user-writable install, and runs the concrete install command through the permission gate."
---

# Resolving missing dependencies

When work is blocked because a **system tool** (e.g. `ripgrep`, `jq`, `cmake`) or a
**language package** (e.g. `zod`, `requests`, `serde`) is not installed, resolve it
deliberately. You are running on the user's own machine — installs are real and
persist — so pick the smallest, least-privileged command that unblocks the task and
let the user approve it.

Never install silently to "just make it work." Confirm what's missing, choose the
narrowest install, and run it through the normal `bash` tool so the permission gate
shows the user the exact command. Do not pipe remote scripts into a shell
(`curl … | sh`) — the gate flags that as dangerous and it is rarely the right way to
get a dependency.

## 1. Confirm it's actually missing

Before installing anything, verify the gap:

- System tool: `command -v <tool>` (or `which <tool>`). Empty output → missing.
- Language package: check the project manifest first (`package.json`,
  `requirements.txt` / `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`). If the
  package is already declared, the fix is usually **install project deps**
  (`npm install`, `pip install -r requirements.txt`), not adding a new one.

If a tool is missing only for this one command, consider whether an already-present
alternative works (e.g. `rg` → `grep -r`, `jq` → a small `node`/`python` one-liner)
before installing.

## 2. Detect the right package manager

**Language packages** — pick from the manifest that exists in the project (do not
guess the ecosystem):

| Manifest present            | Add a package                               | Install declared deps            |
| --------------------------- | ------------------------------------------- | -------------------------------- |
| `package.json`              | `npm install <pkg>` (or `pnpm add`/`yarn add` if that lockfile is present) | `npm install`                    |
| `requirements.txt`          | `pip install <pkg>`                         | `pip install -r requirements.txt`|
| `pyproject.toml` (Poetry)   | `poetry add <pkg>`                          | `poetry install`                 |
| `pyproject.toml` (uv)       | `uv add <pkg>`                              | `uv sync`                        |
| `Cargo.toml`                | `cargo add <pkg>`                           | `cargo build`                    |
| `go.mod`                    | `go get <pkg>`                              | `go mod download`                |
| `Gemfile`                   | `bundle add <pkg>`                          | `bundle install`                 |

Match the lockfile, not just the manifest: `pnpm-lock.yaml` → use `pnpm`,
`yarn.lock` → `yarn`, `bun.lockb` → `bun`. Adding a package edits the manifest —
that's usually wanted, but say so if the user only asked to run something.

**System binaries** — detect the OS package manager by probing, in order, and use the
first one available:

| `command -v` hit | Install command                    | Notes                              |
| ---------------- | ---------------------------------- | ---------------------------------- |
| `brew`           | `brew install <pkg>`               | macOS/Linuxbrew — no sudo, preferred |
| `apt-get`        | `sudo apt-get install -y <pkg>`    | Debian/Ubuntu; run `apt-get update` first if the install 404s |
| `dnf` / `yum`    | `sudo dnf install -y <pkg>`        | Fedora/RHEL                        |
| `apk`            | `apk add <pkg>` (`sudo` if needed) | Alpine                             |
| `pacman`         | `sudo pacman -S --noconfirm <pkg>` | Arch                               |
| `nix-env`        | `nix-env -iA nixpkgs.<pkg>`        | Nix — no sudo                      |
| `zypper`         | `sudo zypper install -y <pkg>`     | openSUSE                           |

The package name is not always the command name (e.g. the `fd` command ships as
`fd-find` on apt, `fd` on brew). If unsure of the exact package name, use the
`web_search` / `web_fetch` tools to confirm it for the detected package manager
before running the install.

## 3. Prefer the least-privileged install

- Reach for a **no-sudo** manager first (`brew`, `nix`, language package managers)
  before a system one that needs `sudo`.
- For language packages outside a project, prefer a **user or isolated install**
  over a global one:
  - Python: a virtualenv (`python -m venv .venv && . .venv/bin/activate`) or
    `pip install --user <pkg>` rather than a system-wide `sudo pip`.
  - Node CLIs you only need to run once: `npx <pkg>` instead of `npm install -g`.
- Only escalate to `sudo` / system-wide when there is no user-writable option and the
  task genuinely needs it. Explain why in the same message so the user's approval is
  informed.

## 4. Run it and verify

Run the chosen command via the `bash` tool (never fabricate success). The permission
gate will surface the exact command to the user — that is intended, so keep the
command to the single thing you need.

After it completes:

1. Re-check availability (`command -v <tool>`, or re-run the failing import/build).
2. Retry the original task.
3. If the install was denied or failed, **stop and tell the user** what's missing and
   the command you would run — do not loop on variants of the same install.

## Notes

- If the environment looks locked-down (read-only filesystem, no package manager
  found, no network), say so plainly and ask how the user wants to proceed rather than
  hunting for a workaround.
- One dependency at a time when debugging a broken environment — install, verify,
  then move on — so a failure is easy to attribute.
