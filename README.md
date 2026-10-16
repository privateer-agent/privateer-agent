<p align="center">
  <img src="brand/privateer_logo.png" alt="Privateer" width="140" />
</p>

<h1 align="center">⚓ Privateer</h1>

<p align="center">
  <strong>A privacy-first, safe-by-default distribution of the <a href="https://pi.dev">Pi</a> coding agent. Bring your own model, keep your own privacy.</strong>
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
</p>

```bash
curl -fsSL https://privateer.pro/install.sh | sh    # macOS / Linux: installs the `privateer` command
irm https://privateer.pro/install.ps1 | iex         # Windows (PowerShell)
npx privateer-agent                                 # or run it instantly, nothing installed
```

Use a frontier model today and a local one tomorrow. **OpenRouter**, **Anthropic**,
**OpenAI**, **Google**, **xAI**, **Groq**, **Mistral**, **Z.ai** (GLM), **DeepSeek**,
**Qwen**, local **Ollama**, **NEAR AI** and **Tinfoil** (verifiable TEE inference),
**Venice** and **Fireworks** (no-retention inference), and any **OpenAI-compatible
endpoint** (LM Studio, vLLM, llama.cpp) are interchangeable with `/model`, even
mid-session. MCP servers, sub-agents, scheduled routines, workflows, chat-app bridges and
one-tap approval from your phone are built in, and every action the agent takes passes
through a **safe-by-default permission gate**.

Privateer runs in three places on one account and one config: the **terminal**,
**Harbor** (a background service for unattended work), and the **Privateer app** on
[phone, web](https://privateer.pro) and [desktop](#desktop-app).

## What's new in 0.15.0

- **Pi 1.3 underneath.** Privateer now runs on Pi 1.3.0.
- **MCP on Pi's built-in support.** Connectors load through Pi's own MCP client instead of
  a separate adapter, and the model calls their tools through **codemode**: it writes a
  short script, and every tool call inside it still goes through the permission gate on
  its own. After upgrading, sign OAuth connectors back in with **`/mcp`**. See
  [Connectors (MCP)](#connectors-mcp).
- **Sub-agents are back.** Hand work to bounded parallel agents that inherit the moat and
  keep their MCP tools.

Earlier releases are on the [releases page](https://github.com/privateer-agent/privateer-agent/releases).

## Why Privateer?

- **No lock-in.** One agent, every provider. `/model` swaps mid-session, and your config,
  commands and agents come along. No vendor's models get special treatment.
- **No API key required.** Bring a key from any supported provider, run keyless against a
  local Ollama, or `/login` to bill a Privateer account instead.
- **Safe by default.** Every edit, shell command and network call is classified and gated
  before it runs. Destructive commands stay blocked even in unattended runs.
- **Privacy you can verify.** Confidential-enclave (TEE) inference is cryptographically
  **attested**, not a policy promise, and an **on-device PII gate** warns before personal
  data leaves your machine for an unverified model.
- **A private sub-agent for your other agents.** Claude Code, Codex or your own
  orchestrator can hand Privateer the files it shouldn't read itself. `privateer -p
  --private "…"` reads them on your machine, reasons over them in an attested enclave, and
  returns only the answer. See [Hand off sensitive work](#hand-off-sensitive-work).
- **It's Pi underneath.** Every Pi extension, skill and command works, and Privateer's own
  features are plain extensions you can read, swap or build on. See [Built on Pi](#built-on-pi).

## Quickstart

```bash
curl -fsSL https://privateer.pro/install.sh | sh    # or: npm install -g privateer-agent
export OPENROUTER_API_KEY=sk-or-...                 # one provider is enough, or skip it and /login
privateer                                           # start the interactive agent
```

The first run walks you through picking a provider and a default model. Then just type.

## Install

```bash
# The installer downloads a self-contained bundle. No Node needed.
curl -fsSL https://privateer.pro/install.sh | sh    # macOS / Linux
irm https://privateer.pro/install.ps1 | iex         # Windows (PowerShell)

# Or manage it with npm yourself (needs Node 22.19 or newer):
npm install -g privateer-agent
npx privateer-agent                                 # run without installing
```

**Requirements:** macOS (arm64 or x64), Linux (x64) or Windows (x64). The installers ship
a pinned Node runtime inside the bundle, so Node is only needed for the npm and npx route.

Update with **`privateer update`**, which re-runs the right installer for how you
installed. Check your version with `privateer --version`.

> **Windows:** the agent's command tool needs bash, which Windows doesn't ship. Install Git
> for Windows (or WSL) and Privateer finds it; the launcher checks at startup and tells you
> how to fix it if not. Override the choice with `shellPath` in
> `~/.privateer/agent/settings.json`. There are no Linux arm64 or Windows arm64 bundles yet;
> Windows on arm64 runs the x64 bundle under emulation.

Background-task logs go to `.pi/tasks` in your working directory. If that directory isn't
writable (Git Bash opened in `C:\Program Files\Git`, for example), they go to
`~/.privateer/agent/tasks/<project-id>/<run-id>` instead. That fallback changes only where
logs are written, not the working directory or what the agent may edit.

### Verify what you're about to run

Privateer runs shell commands and edits files, so it's fair to ask whether you can trust
the package. Before installing:

```bash
npm view privateer-agent dist.attestations   # npm provenance: a signed link from this
                                             # tarball to the commit and CI build behind it
npm audit signatures                         # verify registry signatures and provenance
```

After installing:

```bash
privateer verify        # is the install on this disk still the one we published?
```

`privateer verify` reports the install shape, whether this exact version is published with
a provenance attestation, whether any dependency drifted from its pinned version, and which
launch-time patches are applied. Inconclusive checks are reported as inconclusive, not as a
pass; `--offline` skips the ones that need the registry.

The package declares **no install scripts**, so nothing we publish runs at install time. A
few packages deep in the dependency tree do declare install hooks, and none are needed, so
the install we recommend and test is:

```bash
npm install -g privateer-agent --ignore-scripts
```

The `curl | sh` bundle skips the dependency tree entirely and checks a published SHA-256
before it unpacks anything. See [SECURITY.md](SECURITY.md) for the threat model and how to
report a vulnerability.

**From source:**

```bash
git clone https://github.com/privateer-agent/privateer-agent.git
cd privateer-agent
npm install
npm start
```

## Configure a provider

Privateer reads keys from environment variables, or you can `/login` to an account and skip
keys entirely. One provider is enough:

```bash
export OPENROUTER_API_KEY=sk-or-...      # gateway to almost everything
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
export PRIVATEER_API_KEY=sk-priv-...     # Privateer developer API (privateer.pro)
```

Pick a model with **`/model`**, which browses each provider's live catalog, or pass one as
`provider/model`: `openrouter/anthropic/claude-opus-5`, `ollama/qwen3-coder`,
`nearai/zai-org/GLM-5.1-FP8`. Any OpenAI-compatible server works as a custom provider with
just a base URL. Move the config home with `PRIVATEER_HOME`.

## Built on Pi

Privateer is a distribution of the [Pi](https://pi.dev) coding agent
(`@earendil-works/pi-coding-agent`). Pi provides the runtime, model routing, the TUI, MCP
and the extension, skill and prompt discovery, so **everything that works in Pi works
here**. Privateer adds a *moat* of extensions on top:

| Extension | What it adds |
|---|---|
| `privateer-gate` | the permission gate and the destructive-command filter |
| `privateer-context` | `PRIVATEER.md` project context and the `/init` command |
| `privateer-privacy` | `pi-privacy`: TEE attestation, ZDR routing and the on-device PII gate |
| `privateer-account` | billed inference on a Privateer account (`/login`, device flow) |
| `privateer-posture`, `privateer-tools` | the live attestation shield and Privateer's tool pack |
| `privateer-web` | `web_search` and `web_fetch`, on your account or your own provider |
| `rpiv-ask-user-question` | a structured questionnaire the agent puts to you instead of guessing |
| `privateer-codemode`, `pi-subagents` | how the model calls MCP tools, and bounded parallel sub-agents |

To add your own, drop an extension into `~/.privateer/agent/extensions/`, put a skill or
prompt beside it, or list an npm or git package under `packages` in
`~/.privateer/agent/settings.json`. Pi loads it on the next launch, next to Privateer's own.

**The safety floor can't be lowered from inside.** While the gate is loaded, its block on
destructive shell commands, secret exfiltration and plan-mode escapes sits above every
relaxation: `bypass` mode, the approval allowlist, even a phone-approved remote turn. The
moat is swappable; the floor under it holds.

## Highlights

- **Verifiable private inference** on **NEAR AI** and **Tinfoil**. Models run in a Trusted
  Execution Environment, a status shield shows the live attestation, and `/verify` checks
  the cryptographic report on demand.
- **On-device PII gate.** Prompts headed for an unverified model are scanned locally for
  emails, phone numbers, SSNs, cards, IBANs and IPs, with an offer to redact or hold.
- **Honest privacy grading.** A verified enclave and a "we promise not to retain" policy
  never look the same: cryptographically verified, observable, policy, or none.
- **Drive it from your phone.** `/remote-access` (off by default) lets the app send prompts,
  stream output, and Allow or Deny every action while execution stays on your machine.
- **Manage it from the app.** Extensions, skills, routines, workflows, MCP connectors and
  chat channels are configurable from your phone or the web, for any linked terminal.
- **A desktop app** that hosts the agent locally: no relay hop, works offline, shares your
  CLI login and config.
- **Scheduled routines.** Harbor runs approved tasks unattended, on cron or once, and
  delivers results to a file, your next session, your phone, email or a webhook.
- **Declarative workflows.** Multi-step YAML pipelines with typed steps, conditional routes
  and `human_gate` steps that pause for your approval.
- **Chat-app channels.** Bridge the agent into Telegram, Slack, Discord or WhatsApp, with
  admins who can approve and members who can't.
- **Images and video.** Signed in, the agent can generate images, clips, narration and
  music on your account and cut them together locally with ffmpeg. Files come straight back
  to your machine and aren't stored in our cloud. See [docs/media-generation.md](docs/media-generation.md).
- **Voice, both directions.** `/speak on` reads answers aloud as they're written; **alt+t**
  is push-to-talk. See [Talk to it](#talk-to-it).
- **Named terminals.** The agent opens windows you watch (a dev server, a REPL, a second
  agent), names them, and `/term api` takes you there. See [Named terminals](#named-terminals).
- **MCP, sub-agents and skills**, all gated like everything else. See [Connectors (MCP)](#connectors-mcp).
- **Zero-data-retention routing** for OpenRouter: see a model's retention posture before you
  send, and pin routing to zero-retention endpoints.
- **The everyday tools:** plan mode, checkpoints and rewind, session branching, `/` command
  and `@` file autocomplete, `!` shell passthrough, background shells, and image input for
  vision models.

## Context files: `PRIVATEER.md`

Give the agent standing knowledge about a project (conventions, common commands, domain
notes) with a **`PRIVATEER.md`** in the directory. It's loaded at the start of every turn and
added to the system prompt, the same way Pi loads `AGENTS.md` and `CLAUDE.md`. All three
names are recognized and every matching file is included.

**`/init`** scaffolds a starter file. The startup banner shows a **⚓** line with the loaded
file, the extra files that also apply, and roughly what the context costs per turn.

Discovery starts at `~/.privateer/agent/PRIVATEER.md`, then walks every directory from the
filesystem root down to the current one, so a repo-root file covers every subdirectory and a
deeper file can refine it. `--no-context-files` (`-nc`) turns it off.

## Private and verifiable inference

**NEAR AI Cloud** and **Tinfoil** run every model inside a **Trusted Execution
Environment**: a confidential VM where TLS ends *inside* the enclave, so prompts, weights
and outputs are hidden from the infrastructure provider, the model provider and the host.
Each request can produce a **cryptographic attestation** that it ran on genuine TEE hardware.

- The **status shield** shows the selected model's posture: 🟢 verified, 🟡 returned but
  unconfirmed, 🔴 no attestation.
- **`/verify`** fetches and checks the attestation on demand. For full quote-chain
  validation, take the printed report to the
  [NEAR AI Cloud Verifier](https://github.com/nearai/cloud-verifier) or the
  [Tinfoil verifier](https://github.com/tinfoilsh/tinfoil-cli).
- **Postures are labeled honestly.** A verified enclave (`cryptographic`), a pinned
  zero-retention route (`observable`) and a provider's retention promise (`policy`) are
  shown differently, so a claim never reads like a proof.

## The PII gate

Before a prompt goes to a channel that *isn't* verified private, Privateer scans it
**locally** for structured personal data: emails, phone numbers, SSNs, card numbers
(Luhn-checked), IBANs (mod-97), IP and MAC addresses. If it finds any, it offers to
**redact** or **send as-is**, and can remember your choice for the session. Detection is
deterministic and on-device, and it's skipped on an attested TEE or local model, which
can't read your prompt anyway. It's a best-effort safety net, not a guarantee.

Anything email-*shaped* matches, so some hits aren't personal data. **`/privacy allow
<value>`** takes an address (`me@acme.com`), a domain (`@acme.com`), an IPv4 block
(`10.0.0.0/8`), or an exact or globbed value. Entries live in `privacy.piiAllow` in
`~/.privateer/config.json`, apply from the next turn, and persist. `/privacy` lists them
and `/privacy unallow <value>` removes one. Reserved shapes like `example.com`, loopback
and `noreply@…` are allowed by default. `PI_PRIVACY_*` env vars and a
`pi-privacy.config.json` also work; a project-local file can only make the gate stricter.

Under **no quarter** there's nobody to ask, so the gate redacts, sends, and prints what it
masked.

## Privateer account

Instead of bringing a key, run **`/login`**. Your browser opens an **Authorize this
terminal?** page on privateer.pro; check the code matches the one in your terminal and
click Authorize. Over SSH or on a headless machine, the terminal prints the link and code
to approve from the app instead (`PRIVATEER_NO_BROWSER=1` always does this). No password or
key ever touches the terminal. Inference is billed to your subscription and defaults to a
NEAR TEE model. `/logout` signs out; manage linked terminals from the app.

> **Only approve a code you generated yourself.** The code lets *this* terminal spend on
> your account. Approving a code someone sent you gives *them* a billed session on yours.

## Talk to it

`/speak on` reads answers aloud **as they're written**, sentence by sentence, skipping code
blocks, tables and URLs. Press **alt+t** and talk; the mic closes when you stop, and the
transcript lands in the composer for you to check before Enter sends it.

```
/speak on             read answers aloud    alt+t           push to talk (press again to send)
/speak voice <name>   pick a speaker        /talk           the same thing, typed
/speak rate <n>       0.5x to 3x pace       /talk loop on   hands-free conversation
/speak stream off     wait for the full answer before speaking
/speak provider       list engines; /talk provider does the same
```

Out of the box it uses your **OS voice** (`say`, `espeak-ng`, System.Speech) and nothing
leaves the machine. Signed in, both directions switch to your account's
**confidential-compute TTS and STT**, unless you picked a provider yourself;
`/speak provider local` pins the offline voice. The account voice sends text to an enclave
we can't read, but it does leave your machine. `/speak rate` and `/talk vocab` don't apply
to the account engines yet.

Voice is **off by default and interactive only**: Harbor, ACP and channel sessions never
speak. The mic opens only on something you did. There's no wake word, capture is capped,
audio stays in memory, and a misheard transcript is just a prompt that hits the same gate as
anything you type. Recording needs `sox`, or `arecord`/`parecord`/`ffmpeg` on Linux and
`ffmpeg` on macOS. Settings live in `~/.privateer/speak.json`. The engine is the standalone
[`privateer-speak`](https://www.npmjs.com/package/privateer-speak) package.

## Named terminals

Ask for "a terminal running the dev server" and the agent opens a window, names it, and puts
it in front of you. Every Privateer window names itself too, so you can hop between them:

```
/term                         pick a terminal to switch to
/term api                     switch to "api"
/term open api npm run dev    open one yourself
/term name backend            rename this window
/term close api               close it and end what runs there
/term list                    every named terminal
```

Opening a window with a command goes through the gate like running it in bash; switching and
listing don't ask. The agent can't read what a window prints. These windows are for you.

Voice follows you: with dictation on, the window you switch to listens and the one you left
pauses. Works in **macOS Terminal**, **iTerm2**, **Git Bash (mintty)** on Windows, and
**tmux** anywhere. macOS may ask once for permission to let the terminal control itself.
Names are shared across the machine in `~/.privateer/terminals.json`.

## The Privateer app

The same account drives Privateer from **iOS, Android, [the web](https://privateer.pro) and
desktop**. The terminal is where the work happens; the app is its remote control and
settings screen.

### Link a terminal

1. Run **`privateer`**, then **`/login`**, and approve the code in your browser or in the app
   under **Link a terminal**. The app pins the terminal's public key on first link.
2. Turn on **`/remote-access`** (off by default). The terminal shows as **Online** in the app.

### What you can do from the app

| | |
|---|---|
| **Drive a session** | Send prompts, watch output stream, and **Allow or Deny** each action, including ones from sub-agents |
| **Spawn an agent** | Start a one-shot task on Harbor: *background* (headless, read-only, result sealed to your outbox) or *live* (a fresh session you drive) |
| **Routines** | Create, edit, pause, run and delete scheduled tasks |
| **Workflows** | List, run and monitor workflows; answer `human_gate` steps |
| **MCP connectors** | Add, edit and enable servers; credentials are sealed to the terminal and write-only |
| **Channels** | Configure Telegram, Slack, Discord and WhatsApp: admins, members, posture, tool ceiling, model |
| **Extensions and skills** | Install Pi extensions from the catalog; create, edit and run `SKILL.md` skills |

Changes that carry secrets or executable content (MCP credentials, bot tokens, workflows
with `script` steps) are **sealed to the terminal's key and signed by your account**, so the
relay forwards them blind and can't read or forge them. The relay keeps nothing, carries no
API keys, and output is truncated and run through a secret redactor before it leaves.

### Desktop app

The desktop app hosts the agent **in-process** over loopback IPC: no relay, no network hop,
works offline. It reads the same `~/.privateer` home, so it shares your login, model config
and MCP catalog. It supports multiple windows, each with its own subset of connectors.

Download for [macOS (Apple silicon)](https://privateer.pro/download/mac),
[macOS (Intel)](https://privateer.pro/download/mac-intel) or
[Windows](https://privateer.pro/download/windows). Once installed, **`/desktop`** opens it.
It hosts its own session, so pick your folder from **File ▸ Spawn Privateer at…** and it
starts with this terminal's model and connectors.

It's an early release and **not yet code-signed or notarized**, so macOS warns on first
open. Routines and channels belong to Harbor, not the desktop app.

## Harbor: run it unattended

**Harbor** is a background service that runs scheduled routines and workflows and accepts
tasks from the app, with no terminal open.

```bash
privateer harbor install      # install as a login service
privateer harbor status       # installed? answering?
privateer harbor run          # or run it in the foreground
privateer harbor uninstall
```

It installs as a **launchd user agent** on macOS or a **`systemd --user` unit** on Linux, no
root needed. There's no Windows service yet; use `privateer harbor run`. Logs go to
`~/.privateer/harbor.log` on macOS and to `journalctl --user -u privateer-harbor` on Linux.

Everything Harbor does goes through the gate. Approvals surface in the app, and routines you
approved once run on schedule. Unattended runs are confined to their working directory and
can't read credential stores (`~/.ssh`, `~/.aws`, Privateer's own login), whatever tools
they're allowed.

**Chat channels** run beside it as their own service:

```bash
privateer channels install    # re-run after changing channels from the app
privateer channels status
privateer channels run
```

**On a VPS**, run both as a dedicated unprivileged user, never root: a routine allowed
`bash` has that user's full rights. Log in over SSH with `privateer` and `/login`. Nothing
needs an inbound port except WhatsApp's webhook. In a container without systemd, use
`privateer harbor run` under the container's restart policy.

## Workflows

A workflow is a **YAML pipeline**: typed steps (`agent`, `script`, `human_gate`), conditional
routes between them, and `{{ }}` templating to pass values along. A `human_gate` step pauses
the run until you answer, from your phone if you like.

The engine is the [`privateer-workflow`](https://www.npmjs.com/package/privateer-workflow)
package. You save, run and monitor workflows in the app, and Harbor executes them; there's no
`/workflow` command in the terminal yet. To schedule one, point a routine at it. Saving a
workflow with `script` steps needs your **account signature**, so the server can't inject one.

## Chat-app channels

Bridge the agent into **Telegram, Slack, Discord or WhatsApp** and hand it work from a group
chat. Each channel has:

- **Roles:** `admins` can approve actions; `members` are always read-only.
- **A posture:** `readonly`, `approve` (default) or `auto`.
- **A tool ceiling:** a per-channel allowlist the agent can't exceed, even in `auto`.

Configure channels in the app or in the `channels` block of `~/.privateer/config.json`;
changes apply on restart. Tokens set from the app are write-only, but they're stored in
plaintext in `config.json`. Every channel action is logged to `~/.privateer/channels-audit.log`.

## ACP: drive it from Buzz, Zed or your own program

Privateer speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP v1 over
stdio). An ACP host such as [Buzz](https://buzz.xyz) or [Zed](https://zed.dev) can run
`privateer acp` and drive it: prompts stream back, tool activity shows live, and the model
picker labels TEE-backed models **confidential (TEE)**.

**The host draws the UI; authority stays on your machine.**

- Privateer's own gate classifies every action. ACP only delivers the prompt.
- The **tool ceiling** comes from your local config and defaults to **read-only** (`read`,
  `grep`, `find`, `ls`). The host can't widen it.
- File access is **confined to one root**; anything outside is refused.
- Anything ambiguous (unreachable host, cancelled dialog, aborted turn) resolves to **deny**.
- "Allow for this session" dies with the session, and dangerous shell never becomes
  standing permission.

Zed `settings.json`:

```json
{ "agent_servers": { "Privateer": { "command": "privateer", "args": ["acp"] } } }
```

**Buzz currently auto-approves permission prompts**, so under Buzz the tool ceiling is the
control, which is why it defaults to read-only. Driving Privateer from your own program
works the same way: every approval arrives as a `session/request_permission` call. Setup,
wire format and a minimal client are in [`docs/acp.md`](docs/acp.md). Set `"private": true`
in the `acp` block to hand it data your program shouldn't see.

### One-shot runs (`-p`) and spending

`privateer -p "…"` has no screen, so anything that needs approval is **denied**, including
every billed media tool. Two flags change that for one invocation only; nothing is saved and
no environment variable can turn them on.

```bash
# pre-approve named billed tools, capped by calls and/or estimated dollars
privateer -p --allow-spend generate_video --max-calls 1 --max-spend 1.00 "make a 6s intro clip"

# or approve on your phone; unanswered approvals are denied after the timeout
privateer -p --approve-in-app --approval-timeout 300 "make a 6s intro clip"
```

`--max-spend` is checked before each call against the server's estimate for that call
(`media_capabilities` shows the same prices). A call that can't be priced is refused.

## Hand off sensitive work

Your coding agent's context goes to its provider. When a task touches files that shouldn't
(patient records, a customer export, payroll), the agent can hand that part to Privateer:

```bash
privateer -p --private --model privateer/tinfoil/gemma4-31b \
  "Read customers/export.csv. Reply with the number of customers per country. No row-level data."
```

The calling agent passes file *names*. Privateer reads the files locally, reasons over them
on a verified-private model, and prints only the answer. `--private` makes that a guarantee:

- **No file reaches an unverified model.** Before every tool call the model must be
  `tee-verified` (an enclave quote Privateer checked itself) or `local`.
- **Nothing leaves through a tool.** Web, MCP, media, uploads and network shell commands
  (`curl`, `ssh`, `git push`) are refused.
- **Nothing lifts it.** It sits above permission modes and approvals, `--no-quarter`
  included, and sub-agents inherit it.
- **The caller sees only the answer.** `--private --mode json`, which would stream file
  contents, is refused.

The reply is the one channel left, so ask for aggregates, yes/no answers or summaries, and
have Privateer write details to a file. Setup for Claude Code and other agents, prompt
patterns and the limits are in [`docs/private-handoff.md`](docs/private-handoff.md).

## Connectors (MCP)

Privateer is an **MCP client**, built on Pi's own MCP support. Point it at a
[Model Context Protocol](https://modelcontextprotocol.io) server and its tools become agent
tools, gated like the built-ins.

| | |
|---|---|
| **Local (`stdio`)** | Privateer starts the server as a process on this machine. Nothing leaves except what that server sends. |
| **Remote (`http`)** | A streamable-HTTP endpoint someone else hosts, using OAuth (you authorize in a browser on this machine), a bearer token, or no auth. Whatever the agent sends it leaves your machine, which is why the app badges it "sends data to *host*". SSE-only endpoints aren't supported. |

### Add one

```
/connect                 add, enable, disable or remove connectors
/mcp                     Pi's status view: what connected, and sign-in for OAuth servers
privateer mcp list       the same from the shell (also: login, logout, add, remove)
```

`/connect` opens a catalog of 23 connectors (GitHub, Slack, Notion, Linear, Atlassian,
Sentry, Stripe, Asana, Supabase, Figma, Gmail, Google Drive, PostgreSQL, Playwright,
Filesystem and more) plus a **Custom connector** for any stdio command or `https://` URL.
New tools are live in the session you're already in. The app and desktop app edit the same
config.

> **Upgrading from 0.14?** OAuth connectors need signing in once more on the new MCP client.
> Run `/mcp` and sign each one back in.

### Config files

```
~/.privateer/agent/mcp-desktop.json   # source of truth: every connector, each with `enabled`
~/.privateer/agent/mcp.json           # generated for Pi from the file above
```

Don't edit `mcp.json` by hand; it's rewritten on every change (a file from an older
release is converted once at launch). Edit `mcp-desktop.json` or use `/connect`. Both live
in `~/.privateer`, so a connector you add in the terminal is also there for Harbor and the
desktop app.

### Tools and the gate

The model reaches MCP tools through **codemode**: it writes a short script that calls them.
Each call inside that script reaches the gate on its own as `mcp__<server>__<tool>`, so
**every MCP tool goes through the same permission gate as the built-ins**. Configuring a
server doesn't make its tools trusted. Codemode scripts can't run models with your keys.

A routine can carry a per-connector allow-list, so an unattended task can hold GitHub's
`create_issue` without holding all of MCP. A routine with no allow-list gets no MCP tools.

### Credentials

Connector secrets (env values, bearer tokens, `Authorization` headers) are stored in
**plaintext** in `mcp-desktop.json` and `mcp.json`, because the server needs the real
token. `/connect` masks the field while you type, but that's screen hygiene, not storage
protection. Guard those files like `~/.aws/credentials`.

From **the app**, secrets are write-only: listings show which names are set, never values,
and a value you type is sealed to the terminal's key before it leaves your phone.

A project's `.mcp.json` or `.pi/mcp.json` is a **protected path**: the agent can be asked to
edit one, but never silently.

> **Hosted harbors are OAuth-only by design**: no stdio processes and no stored tokens. In
> the current preview they carry no connectors at all.

## Permission modes

| Mode | Behavior |
|---|---|
| `default` | ask before edits and shell commands |
| `acceptEdits` | auto-approve file edits; still ask for shell commands |
| `bypass` | no prompts (destructive commands are *still* blocked) |
| `plan` | read-only; the agent presents a plan for you to approve |

Switch with **`/mode`**. Even in `bypass`, destructive shell commands are blocked and
protected files (`.env`, shell rc files) are guarded.

### No quarter: lower the moat entirely

The one exception. **No quarter** turns the gate off for the **whole session**: every action
auto-approves, including destructive commands, access outside the working directory, and
protected files. Sub-agents started after it's on inherit it. Use it only for a directory
and a task you fully trust.

| | |
|---|---|
| **shift+tab** | toggle it mid-session; the agent then runs to the end instead of stopping at the next approval |
| `/no-quarter [on\|off]` | the typed equivalent |
| `privateer --no-quarter` | start a session with the moat already down |

It's never quiet: the flag prints a red warning, the toggle posts one to the transcript, and
the footer shows `⚑ no quarter, permission gate OFF` while it's on. An approval already on
screen still needs an answer, and a phone driving the terminal can't flip it (the app has
its own toggle for driven turns). A hard plan-mode deny still holds.

> shift+tab is Pi's default "cycle thinking level" key. Thinking level is still under
> `/settings`, or bind `app.thinking.cycle` to another key in
> `~/.privateer/agent/keybindings.json`.

## Extend it

Everything here is a Pi extension loaded by discovery (see [Built on Pi](#built-on-pi)), and
yours load the same way, gated like the rest.

- **MCP servers** through Pi's built-in support and codemode. See [Connectors (MCP)](#connectors-mcp).
- **Sub-agents** (`pi-subagents`): delegate to bounded parallel agents. Children run as
  headless processes that **inherit the moat** and keep MCP, so their actions hit the same
  gate and their approvals reach your phone.
- **Routines:** tasks Harbor runs unattended. Ask the agent to schedule work and approve it once.
- **Workflows:** multi-step pipelines Harbor executes. See [Workflows](#workflows).
- **Web tools** (`privateer-web`): `web_search` and `web_fetch`. Signed in, they run on your
  account with no key to manage; the search query is visible to Privateer, the pages and
  conversation aren't. Set your own provider with `/web-tools` (`rpiv-web-tools`, including
  self-hosted SearXNG) and it takes over. Unattended runs always use the account route, so a
  routine never holds a provider key it could be tricked into leaking.
- **Ask user question** (`rpiv-ask-user-question`): when a request is unclear, the agent asks
  a structured question with options, multi-select or free text, instead of guessing.

## Command reference

| Command | What it does |
|---|---|
| `/model` · `/models` | switch model; `/models` is a searchable picker with TEE/ZDR shields |
| `/mode` | switch permission mode |
| `/no-quarter` | turn the gate off for this session (**shift+tab**) |
| `/verify` | fetch and check the TEE attestation for the current model |
| `/login` · `/logout` | log in to a Privateer account (device flow) / log out |
| `/remote-access` | let the app drive this terminal (off by default) |
| `/connect` · `/mcp` | manage MCP connectors / see what connected and sign in |
| `/speak` · `/talk` | read answers aloud / voice input (**alt+t** is push-to-talk) |
| `/mood` | pick a voice mood, or `/mood save <name>` to keep your current setup |
| `/fresh` | replace this agent with a new process and stop everything it started (`/resume` still reaches the old session) |
| `/extensions` | list loaded Pi extensions |
| `/web-tools` | point web search and fetch at your own provider |
| `/init` | scaffold a starter `PRIVATEER.md` |
| `/desktop` | open the [desktop app](#desktop-app) |
| `/update` · `/privateer` | update to the latest release / account status and posture |

Shell commands:

| Command | What it does |
|---|---|
| `privateer` | start the interactive agent |
| `privateer update` · `privateer --version` | update / show the version |
| `privateer verify` | check this install against what was published |
| `privateer auth status` | is this machine logged in? |
| `privateer harbor …` · `privateer channels …` | manage the background services |
| `privateer mcp list\|login\|logout\|add\|remove` | manage MCP servers from the shell |
| `privateer acp` | serve the agent to an ACP host ([`docs/acp.md`](docs/acp.md)) |
| `privateer fresh [n]` | swap a running terminal's agent from another terminal, even a stuck one |
| `privateer -p "…"` | one-shot run ([spending flags](#one-shot-runs--p-and-spending)) |
| `privateer --private` | tools only on a verified-private model, never the network ([details](#hand-off-sensitive-work)) |
| `privateer --no-quarter` | start with the gate off |

## Develop

```bash
npm run typecheck
npm test
```

## License

[MIT](LICENSE) © Patrick
