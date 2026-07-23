<p align="center">
  <img src="brand/privateer_logo.png" alt="Privateer" width="140" />
</p>

<h1 align="center">⚓ Privateer</h1>

<p align="center">
  <strong>A privacy-first, safe-by-default distribution of the <a href="https://pi.dev">Pi</a> coding agent — bring your own model, keep your own privacy.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/privateer-agent">
    <img src="https://img.shields.io/npm/v/privateer-agent" alt="npm" />
  </a>
  <a href="https://github.com/privateer-agent/privateer-agent/releases">
    <img src="https://img.shields.io/badge/changelog-what's%20new-5b8def" alt="Changelog" />
  </a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.19-brightgreen" alt="Node >= 22.19" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  <img src="https://img.shields.io/badge/permissions-safe%20by%20default-2ea44f" alt="Safe by default" />
  <img src="https://img.shields.io/badge/inference-TEE%20attested%20·%20on--device%20PII%20gate-5b8def" alt="Private inference" />
  <img src="https://img.shields.io/badge/providers-OpenRouter%20·%20Anthropic%20·%20OpenAI%20·%20Google%20·%20xAI%20·%20Groq%20·%20Mistral%20·%20Z.ai%20·%20DeepSeek%20·%20Qwen%20·%20Ollama%20·%20NEAR%20AI%20·%20Tinfoil%20·%20Venice-5b8def" alt="Providers" />
</p>

```bash
curl -fsSL https://privateer.pro/install.sh | sh    # macOS / Linux — installs the `privateer` command
irm https://privateer.pro/install.ps1 | iex         # Windows (PowerShell)
npx privateer-agent                                 # or run it instantly, nothing installed
```

Point it at a frontier model today and a local Ollama model tomorrow — **OpenRouter**,
**Anthropic**, **OpenAI**, **Google**, **xAI**, **Groq**, **Mistral**, **Z.ai** (GLM),
**DeepSeek**, **Qwen**, local **Ollama**, **NEAR AI** or **Tinfoil** (verifiable TEE
inference), **Venice** / **Fireworks** (no-retention inference), and any **custom
OpenAI-compatible endpoint** (LM Studio, vLLM, llama.cpp…) are interchangeable at
`/model` time, including mid-session. No model lock-in, no separate code paths. MCP
servers, sub-agents, scheduled routines, multi-step workflows, chat-app bridges, and
one-tap approval from your phone are included — and every one of the agent's actions runs
through a **safe-by-default permission gate**.

Privateer runs in three places, over one account and one config: the **terminal**,
**Harbor** (a background service) for unattended work, and the **Privateer app** on
[phone, web](https://privateer.pro), and [desktop](#the-privateer-app).

## Why Privateer?

- **No lock-in.** One agent, every provider. `/model` swaps mid-session and your config,
  commands, and agents come along for the ride. No vendor's models are privileged.
- **No API key required.** Bring your own key from any supported provider, run keyless
  against a local Ollama — or `/signin` to bill a Privateer account instead.
- **Safe by default.** Every edit, shell command, and network call is classified and gated
  before it runs; destructive commands are blocked even in unattended runs. You stay in
  control, whether you're watching or not.
- **Privacy you can verify, not just trust.** Confidential-enclave (TEE) inference is
  cryptographically **attested** — not a policy promise — and an **on-device PII gate**
  warns before structured personal data ever leaves your machine for an unverified model.
- **It's Pi underneath.** Privateer is a distribution of the [Pi](https://pi.dev) coding agent —
  every Pi extension, skill, and command works, and Privateer's own features are just extensions
  you can read, swap, or build on. Nothing to compile. See [Built on Pi](#built-on-pi).

## Built on Pi

Privateer is a **distribution of the [Pi](https://pi.dev) coding agent**
(`@earendil-works/pi-coding-agent`): Pi is the runtime, the model routing, the interactive TUI,
and the extension / skill / prompt discovery system — **everything that works in Pi works here.**
What Privateer adds is a *moat* of Pi extensions layered on top:

| Extension | What it adds |
|---|---|
| `privateer-gate` | safe-by-default permission gate + destructive-command danger filter |
| `privateer-context` | loads `PRIVATEER.md` project context (like `AGENTS.md`/`CLAUDE.md`) + the `/init` command |
| `privateer-privacy` | `pi-privacy` — TEE attestation, ZDR routing, on-device PII gate — bound to the account tier resolver |
| `privateer-account` | `/signin` billed inference against a Privateer account (device flow) |
| `privateer-posture`, `privateer-tools` | live attestation shield + Privateer tool pack |
| `rpiv-web-tools` | private-by-default web search (self-hosted SearXNG, no WebView) |
| `pi-mcp-adapter`, `pi-subagents` | MCP servers · bounded parallel sub-agents |

They're ordinary Pi extensions — inspect them, replace them, or build your own alongside.
**Extend by discovery:** drop an extension into `~/.privateer/agent/extensions/` (move the home
with `PRIVATEER_HOME`), add a skill or prompt beside it, or list an npm/git package under
`packages` in `~/.privateer/agent/settings.json` — Pi auto-loads them on next launch, right next
to Privateer's own. Any extension from the Pi ecosystem loads the same way. (There's no CLI flag
for this — discovery is the entry point.)

**The floor you can't lower is the safety gate.** While it's loaded, its block on destructive
shell commands, secret exfiltration, and plan-mode escapes sits *above* every relaxation —
`bypass` mode, the approval allowlist, even a phone-approved remote turn can't fire them
silently. The moat is swappable; the floor under it holds.

## Highlights

- **Private, verifiable inference** via **NEAR AI** and **Tinfoil**: every model runs inside
  a Trusted Execution Environment, a live status shield reflects the attestation, and
  `/verify` fetches and checks the cryptographic report on demand — genuine proof the
  inference ran on real confidential hardware, not a terms-of-service page.
- **On-device PII gate.** Before a prompt goes to an *unverified* channel, Privateer scans it
  locally for structured personal data (emails, phone numbers, SSNs, cards, IBANs, IPs…) and
  offers to redact or hold it — detection never leaves your machine, and an attested TEE
  channel skips the check because it provably can't read your data anyway.
- **Honest privacy posture, graded.** A verified TEE and a "we promise not to retain"
  policy are **never rendered the same** — the badge tells you exactly how strong the
  guarantee is (cryptographically verified → observable → policy → none).
- **Drive it from your phone.** Link the terminal with `/remote-access` (off by default) and
  the Privateer app can send prompts, stream output, and Allow/Deny every action — while
  execution stays on your machine. Sub-agent actions surface for approval the same way.
- **Manage it from the app.** Extensions, skills, routines, workflows, MCP connectors, and
  chat-app channels are all configurable from your phone or the web app, against any linked
  terminal. See [The Privateer app](#the-privateer-app).
- **A desktop app.** The same agent hosted inside a local Electron shell — no relay hop, works
  offline, multi-window with per-window MCP connectors. Shares your CLI login and config.
- **Scheduled routines.** Harbor, a background service, runs approved tasks unattended — cron or
  one-off — and the agent can schedule its own follow-up work. Results deliver to a file,
  the next session, your phone, email, or a webhook.
- **Declarative workflows.** Multi-step agent pipelines as YAML — typed steps, conditional
  routing between them, and `human_gate` steps that pause for your approval and resume.
- **Chat-app channels.** Bridge the agent into Telegram, Slack, Discord, or WhatsApp with
  role-based approval — admins can approve actions, members are read-only.
- **MCP servers, sub-agents & skills.** Connect Model Context Protocol servers (local stdio
  or remote HTTP with OAuth), delegate work to bounded parallel sub-agents, and drop in
  skills — all gated like everything else.
- **Zero-Data-Retention surfacing** for OpenRouter — see the selected model's retention
  posture before you send, and pin routing to zero-retention endpoints.
- **Plan mode**, checkpoint/rewind, session branching, a modal prompt with `/` command and
  `@` file autocomplete, `!` shell passthrough, background shells, and image attachment for
  vision-capable models.

## Quickstart

```bash
curl -fsSL https://privateer.pro/install.sh | sh    # or: npm install -g privateer-agent
export OPENROUTER_API_KEY=sk-or-...                 # one provider is enough — or skip and /signin
privateer                                           # launches the interactive agent
```

First run walks you through picking a provider and default model. From there, just type.
No install at all: `npx privateer-agent`.

## Install

```bash
# the one-liner installer — downloads a self-contained bundle, no Node needed:
curl -fsSL https://privateer.pro/install.sh | sh    # macOS / Linux
irm https://privateer.pro/install.ps1 | iex        # Windows (PowerShell)

# or via npm, if you'd rather manage it yourself (needs Node ≥ 22.19):
npm install -g privateer-agent
npx privateer-agent                                 # run without installing
```

**Requirements:** macOS (arm64/x64), Linux (x64), or Windows (x64). The installers ship a
**pinned Node runtime inside the bundle**, so you don't need Node or npm on your machine at
all — Node ≥ 22.19.0 is only required for the `npm` / `npx` path.

Update in place with **`privateer update`** (bundle-aware: it re-runs the right installer
for how you installed) or check your version with `privateer --version`.

> **Windows:** the agent's command tool needs a bash, which Windows doesn't ship. Install
> Git for Windows (or WSL) and Privateer will find it; the launcher checks at startup and
> tells you how to fix it if not. Override the choice with `shellPath` in
> `~/.privateer/agent/settings.json`. Linux arm64 and Windows arm64 bundles aren't built
> yet — arm64 Windows runs the x64 bundle under emulation.

### Verifying what you're about to run

Privateer is a coding agent — it runs shell commands and edits files, so "should I trust
this package?" is the right question to ask before `npx`. Two things are checkable
without taking anyone's word for it:

```bash
npm view privateer-agent dist.attestations   # published from CI with npm provenance:
                                             # a signed link from this tarball to the
                                             # exact commit and build that produced it
npm audit signatures                         # verify registry signatures + provenance
```

The package also declares **no install scripts** — no `postinstall`, nothing. Installing
it writes files and executes nothing; `npm install -g privateer-agent --ignore-scripts`
gives an identical result. Code runs only when you run `privateer`.

See [SECURITY.md](SECURITY.md) for the threat model, the permission gate, and how to
report a vulnerability.

**From source:**

```bash
git clone https://github.com/privateer-agent/privateer-agent.git
cd privateer-agent
npm install
npm start            # launches the interactive agent
```

## Configure a provider

Privateer reads credentials from environment variables (or sign in to an account and skip
keys entirely). One provider is enough to start:

```bash
export OPENROUTER_API_KEY=sk-or-...      # gateway to ~everything
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GEMINI_API_KEY=AIza...            # Google
export XAI_API_KEY=xai-...               # xAI (Grok)
export GROQ_API_KEY=gsk_...              # Groq
export DEEPSEEK_API_KEY=sk-...           # DeepSeek
export OLLAMA_BASE_URL=http://localhost:11434/v1   # local, keyless
export NEAR_AI_API_KEY=...               # verifiable TEE inference (cloud.near.ai)
export TINFOIL_API_KEY=...               # verifiable TEE inference (tinfoil.sh)
export VENICE_API_KEY=vapi_...           # no-retention inference
export PRIVATEER_API_KEY=sk-priv-...      # Privateer developer API (privateer.pro); or /signin instead
```

Pick a model with **`/model`** (browse each configured provider's live catalog) or pass one
directly as `provider/model` — e.g. `openrouter/anthropic/claude-opus-4.8`,
`ollama/qwen3-coder`, `nearai/zai-org/GLM-5.1-FP8`. Any OpenAI-compatible server (LM Studio,
vLLM, llama.cpp) works as a custom provider — just give it a base URL.

Override the config location with `PRIVATEER_HOME`.

## Context files — `PRIVATEER.md`

Give the agent standing knowledge about your project — conventions, common commands,
domain notes — by dropping a **`PRIVATEER.md`** in the directory. Privateer loads it
automatically at the start of every turn and prepends it to the model's system prompt,
exactly the way Pi loads `AGENTS.md` / `CLAUDE.md` (all three are recognized, and all
matching files are concatenated).

Run **`/init`** to scaffold a starter `PRIVATEER.md` in the current directory, then edit
it. The startup banner shows a **⚓** line with the loaded file's path (and a `+N` count
when ancestor files also apply), or a `/init` hint when none is found.

Discovery mirrors Pi's context-file lookup: the global agent dir
(`~/.privateer/agent/PRIVATEER.md`) first, then every directory from the filesystem root
down to the current one — so a repo-root `PRIVATEER.md` applies to every subdirectory, and
a deeper file can refine it. `AGENTS.md` and `CLAUDE.md` continue to work unchanged; use
`--no-context-files` (`-nc`) to disable context-file loading entirely.

## Private & verifiable inference

**NEAR AI Cloud** and **Tinfoil** run every model inside a **Trusted Execution Environment** —
a confidential VM where TLS terminates *inside* the enclave, so your prompt's inputs, weights,
and outputs are invisible to the infrastructure provider, the model provider, and the host
itself. It isn't "trust us": each request can produce a **cryptographic attestation** proving
the inference ran on genuine TEE hardware.

- A **status shield** colors the selected model's live posture — 🟢 verified, 🟡 returned but
  unconfirmed, 🔴 no attestation material.
- **`/verify`** fetches the attestation on demand and prints the evidence. Privateer does a
  pragmatic terminal-suited check; take the printed report to the
  [NEAR AI Cloud Verifier](https://github.com/nearai/cloud-verifier) or the
  [Tinfoil verifier](https://github.com/tinfoilsh/tinfoil-cli) for full quote-chain validation.
- **The posture is graded honestly.** A verified enclave (`cryptographic`), a pinned
  zero-retention route (`observable`), and a provider's retention *promise* (`policy`) are
  labeled distinctly — a claim never gets to read like a proof.

## The PII gate

Before any prompt is sent to a channel that *isn't* verified-private, Privateer scans it
**locally** for structured personal data — emails, phone numbers, SSNs, credit-card numbers
(Luhn-checked), IBANs (mod-97), IP and MAC addresses. If it finds any, it warns and offers to
**redact** or **send as-is** (or remember your choice for the session). Detection is
deterministic and on-device — no model ever sees the data in order to find it — and it's
skipped entirely on an attested TEE or on-device channel, which provably can't read your
prompt anyway. It's best-effort structured-PII detection, labeled as such — a safety net, not
a guarantee.

## Privateer account (billed inference)

Instead of bringing your own key, run **`/signin`** to sign into a Privateer account — an
app-brokered device flow where you approve a short code in the Privateer app, so wallet and
email accounts work identically and no password or key ever touches the terminal. Inference
is then billed to your subscription and defaults to a **NEAR TEE** model. Sign out any time
with `/signout`; manage linked terminals from the app.

> **Only approve a sign-in code you generated yourself.** The code authorizes *this* terminal
> to spend on your account. If someone sends you a code and asks you to approve it, don't —
> that hands *them* a billed session on *your* account.

## The Privateer app

The same account drives Privateer from **iOS, Android, [the web app](https://privateer.pro),
and a desktop app**. The terminal stays where the work happens — the app is a remote control
and a management surface for it.

### Linking a terminal

1. Run **`privateer`** and **`/signin`**. It prints a short device code.
2. Open the app → **Link a terminal**, enter the code (or tap the deep link). No password or
   wallet key ever touches the terminal, and the app pins the terminal's public key on first
   link.
3. In the terminal, turn on **`/remote-access`** (off by default). The terminal now shows
   **Online** in the app.

> **Only approve a code you generated yourself.** Approving someone else's code hands *them*
> a billed session on *your* account.

### What you can do from the app

| | |
|---|---|
| **Drive a session** | Send prompts, watch streamed output, and **Allow/Deny** each proposed action — including actions from sub-agents the session spawned |
| **Spawn an agent** | Start a one-shot task on the harbor: *background* (headless, read-only toolset, result sealed to your outbox) or *live* (a fresh drivable session) |
| **Routines** | Create, edit, pause, run, and delete scheduled unattended tasks |
| **Workflows** | List, run, and monitor multi-step workflows; answer `human_gate` steps to resume a paused run |
| **MCP connectors** | Add, edit, and enable MCP servers; credentials are sealed to the terminal and write-only |
| **Channels** | Configure the Telegram / Slack / Discord / WhatsApp bridges — admins, members, posture, tool ceiling, model |
| **Extensions & skills** | Install Pi extensions from the catalog; create, edit, and run `SKILL.md` skills |

Config changes that carry secrets or executable content (MCP credentials, channel bot
tokens, workflows with `script` steps) are **sealed to the terminal's pinned key and signed
by your account** — the relay forwards them blind and can neither read nor forge them.

The relay itself is live-only (nothing is archived), carries no API keys, and output is
size-truncated and run through a best-effort secret redactor before it leaves your machine.

### Desktop app

The desktop app hosts the agent **in-process** and talks to it over loopback IPC — no relay,
no network hop, and it works offline. It reads the same `~/.privateer` home, so it shares
your CLI login, model config, and MCP catalog. Multi-window, with a per-window subset of
your MCP connectors and a native folder picker.

Download for [macOS](https://privateer.pro/download/mac) (Apple silicon),
[macOS Intel](https://privateer.pro/download/mac-intel), or
[Windows](https://privateer.pro/download/windows).

It's an early release and **not yet code-signed or notarized** — macOS will warn on first
open. Routines and channels deliberately aren't hosted here: those belong to the always-on
harbor, so background work still wants `privateer harbor install`.

## Run it unattended — Harbor

**Harbor** is a resident background service that runs scheduled routines, executes workflows,
and accepts task spawns from the app — with no terminal open.

```bash
privateer harbor install      # install as a login service (auto-starts, reachable from the app)
privateer harbor status       # service installed? harbor answering?
privateer harbor run          # or just run it in the foreground
privateer harbor uninstall
```

Installs as a **launchd user agent** on macOS or a **`systemd --user` unit** on Linux — no
root, no sudo. (There's no Windows service path yet; use `privateer harbor run`.)

Everything the harbor does still runs through the permission gate. Actions needing approval
surface in the app; routines you approved once run on their own schedule.

## Workflows

A workflow is a **YAML file describing a multi-step agent pipeline** — a flat graph of typed
steps (`agent`, `script`, `human_gate`) with conditional routes between them and `{{ }}`
templating to pass values along. A `human_gate` step pauses the run for your approval and
resumes when you answer it, including from your phone.

The engine ships in the standalone
[`privateer-workflow`](https://www.npmjs.com/package/privateer-workflow) package. Today the
user-facing surface is the **app** (save, run, monitor, share) and the **harbor** that
executes them — there's no `/workflow` command in the terminal yet. Schedule one by pointing
a routine at it.

Because a workflow can carry `script` steps, saving one from the app requires your **account
signature** — the server can't inject a workflow onto your harbor.

## Chat-app channels

Bridge the agent into **Telegram, Slack, Discord, or WhatsApp** so you can hand it work from
a group chat. Each channel has:

- **Roles** — `admins` can approve actions; `members` are always read-only, no exceptions.
- **A posture** — `readonly`, `approve` (default), or `auto`.
- **A hard tool ceiling** — a per-channel allowlist the agent can't exceed even in `auto`.

Configure a channel from the app, or by hand in the `channels` block of
`~/.privateer/config.json`. Changes take effect on restart, by design. Bot tokens set from
the app are write-only — the app can name them but never read them back. Note that tokens
live in plaintext in `config.json` on your machine, and every channel action is appended to
`~/.privateer/channels-audit.log`.

## Permission modes

| Mode | Behavior |
|---|---|
| `default` | prompt before edits and shell commands |
| `acceptEdits` | auto-approve file edits; still prompt for shell commands |
| `bypass` | no prompts (destructive commands are *still* blocked) |
| `plan` | read-only; the agent presents a plan, then you approve to proceed |

Switch with **`/mode`**. Even in `bypass`, a danger filter blocks destructive shell commands,
and protected files (`.env`, shell rc files…) are guarded — the gate is never fully off.

### `--no-quarter` — lower the moat entirely

For an unattended run in a directory and on a task you fully trust, launch with:

```bash
privateer --no-quarter
```

This is the one exception to "the gate is never fully off." It disables the permission
gate for the **whole session** — every action auto-approves with no prompt, including
destructive shell commands, out-of-cwd access, and protected files. Subagents spawned
by the session inherit it. There is no `/mode` equivalent; it's a deliberate launch-time
opt-out (env `PRIVATEER_NO_QUARTER=1`) and prints a red warning banner so it's never a
surprise. Use it sparingly.

## Extend it

Everything below is a **Pi extension** loaded by discovery (see [Built on Pi](#built-on-pi)) —
drop your own into `~/.privateer/agent/extensions/` and it loads the same way, gated like the rest.

- **MCP servers** (`pi-mcp-adapter`) — declare them and their tools become first-class, gated
  like the rest (local stdio, or remote HTTP with interactive OAuth). One catalog at
  `~/.privateer/agent/mcp-desktop.json` is shared by the CLI, the harbor, and the desktop
  app, so a machine has one coherent connector config.
- **Sub-agents** (`pi-subagents`) — delegate investigations to bounded parallel agents. Children
  run as headless child processes that **inherit the moat**, so their actions hit the same
  permission gate and their approvals surface on your phone.
- **Routines** — saved tasks the harbor runs unattended; ask the agent to schedule work and
  approve it once.
- **Workflows** — declarative multi-step pipelines the harbor executes; see
  [Workflows](#workflows).
- **Web tools** (`rpiv-web-tools`) — private-by-default web search/fetch with pluggable backends
  (self-hosted SearXNG for fully private search).

## Command reference

| Command | What it does |
|---|---|
| `/model` · `/models` | switch model; `/models` is a searchable picker with TEE/ZDR privacy shields |
| `/mode` | switch permission mode |
| `/verify` | fetch and check the TEE attestation for the current model |
| `/signin` · `/signout` | sign in to a Privateer account (device flow) / sign out |
| `/remote-access` | link this terminal to the app and allow it to drive (off by default) |
| `/extensions` | list loaded Pi extensions |
| `/init` | scaffold a starter `PRIVATEER.md` in this directory |
| `/update` · `/privateer` | update to the latest release / Privateer status and posture |

Shell subcommands: `privateer` (interactive), `privateer update`, `privateer harbor …`,
`privateer --no-quarter`, `privateer --version`.

## Develop

```bash
npm run typecheck
npm test
```

## Changelog

Release notes and what's new in each version live on the
[**GitHub releases page**](https://github.com/privateer-agent/privateer-agent/releases).
Privateer keeps its startup clean — the app won't dump a changelog into your terminal.

## License

[MIT](LICENSE) © Patrick
