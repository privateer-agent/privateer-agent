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
| `privateer-web` | `web_search`/`web_fetch` — your account's search once signed in, or your own provider (`rpiv-web-tools`: self-hosted SearXNG, Brave, Tavily…) |
| `rpiv-ask-user-question` | `ask_user_question` — a structured questionnaire the agent puts to you instead of guessing |
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
- **Make images and video.** Signed in, the agent can generate images, video clips, narration
  and music on your account — and stitch them together locally with ffmpeg. It plans the whole
  piece: render the stills, animate them, carry the last frame of one clip into the next so the
  shots stay continuous, cut them together, then score and narrate the result. Generated media
  is handed straight back as files on your machine; none of it is stored in our cloud. See
  [docs/media-generation.md](docs/media-generation.md).
- **Talk to it.** `/speak on` reads answers aloud as they're written; **alt+t** is push-to-talk
  and the mic closes when you stop talking. Your OS voice by default — nothing leaves the
  machine — or your account's confidential-compute TTS/STT once you sign in. `/talk loop on`
  makes it hands-free. See [Talk to it](#talk-to-it--voice-both-directions).
- **MCP servers, sub-agents & skills.** Connect Model Context Protocol servers (local stdio
  or remote HTTP with OAuth) with [`/connect`](#connectors--mcp), delegate work to bounded
  parallel sub-agents, and drop in skills — all gated like everything else.
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

And **after** installing — the check nobody else offers, because every signal above is
an install-time one:

```bash
privateer verify        # is the install on THIS disk still the one we published?
```

It reports the install shape, whether this exact version is published and carries a
provenance attestation, whether any dependency has drifted from its pinned version,
and which launch-time patches are applied. Inconclusive checks say so rather than
counting as a pass; `--offline` skips the ones that need the registry.

The package also declares **no install scripts** — no `postinstall`, nothing — so
nothing we publish executes at install time, and `--ignore-scripts` gives an identical
result. That is a claim about *our* tarball, not your whole install: a handful of
packages in the ~500-package dependency tree do declare install hooks, and none of them
are needed here, so the install we recommend and test is

```bash
npm install -g privateer-agent --ignore-scripts
```

Or skip the dependency graph entirely with a bundle (the `curl | sh` one-liner above),
which verifies a published SHA-256 and, from the next release on, a signed build
attestation before it unpacks anything.

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
directly as `provider/model` — e.g. `openrouter/anthropic/claude-opus-5`,
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

Pattern detection fires on anything email-*shaped*, so some of what it finds isn't personal
data at all. **`/privacy allow <value>`** is where you say so — an address
(`me@acme.com`), a domain (`@acme.com`), an IPv4 block (`10.0.0.0/8`), or any exact or
globbed value. Entries live in `privacy.piiAllow` in `~/.privateer/config.json`, apply from
the next turn (no relaunch), and persist across sessions; `/privacy` on its own lists them
and `/privacy unallow <value>` puts one back under the gate. Reserved shapes —
`example.com`, loopback, `noreply@…`, `@users.noreply.github.com` — are allowed out of the
box. `PI_PRIVACY_*` env vars and a `pi-privacy.config.json` are honoured too (a
project-local file can only ever make the gate *stricter*).

Under **no quarter** the gate doesn't ask — there's nobody to ask — so it redacts and sends,
and prints what it masked. That's the one case where a false positive changes what the model
sees without you seeing it first, which is why the notice tells you `/privacy allow` exists.

## Privateer account (billed inference)

Instead of bringing your own key, run **`/signin`** to sign into a Privateer account. Your
browser opens straight onto an **Authorize this terminal?** page on privateer.pro — check the
code on the page matches the one in your terminal and click Authorize; the terminal signs
itself in moments later. (Over SSH or on a headless box the terminal prints the link and code
to approve from the app instead — set `PRIVATEER_NO_BROWSER=1` to always do that.) Wallet and
email accounts work identically and no password or key ever touches the terminal. Inference
is then billed to your subscription and defaults to a **NEAR TEE** model. Sign out any time
with `/signout`; manage linked terminals from the app.

> **Only approve a sign-in code you generated yourself.** The code authorizes *this* terminal
> to spend on your account. If someone sends you a code and asks you to approve it, don't —
> that hands *them* a billed session on *your* account.

## Talk to it — voice, both directions

`/speak on` and answers are read aloud **as they are written**, sentence by sentence, with
code blocks, tables and URLs stripped. Press **alt+t** and talk; the mic closes when you
stop talking and the transcript lands in the composer for you to read before Enter sends it.

```
/speak on             read answers aloud    alt+t     push to talk (press again to send)
/speak voice <name>   pick a speaker        /talk     the same thing, typed
/speak rate <n>       0.5–3× pace           /talk loop on   conversation mode, hands-free
/speak stream off     wait for the full answer instead of speaking as it arrives
/speak provider       list engines (→ marks the active one); /talk provider does the same
```

Out of the box it uses your **OS voice** (`say`, `espeak-ng`, System.Speech) and nothing
leaves the machine. Signed in, both directions quietly upgrade to your account's
**confidential-compute TTS and STT** — attested-enclave models, the same ones the app's voice
features use, inherited entitlement and billing. That is an upgrade, not a stomp: a provider
you picked deliberately stays picked, and `/speak provider local` pins the offline voice for
good. Be clear-eyed about the difference — the local voice never speaks to the network, while
the account voice sends the utterance text to an enclave we can't read into but that is still
off your machine.

One caveat while the account endpoints catch up: `/speak rate` and `/talk vocab` are honored
by the local and OpenAI-compatible engines, not yet by the account's TTS/STT.

Voice is **off by default and interactive-only** — harbor, ACP and channel sessions never
speak. The mic opens only on something you did (`/talk`, the push-to-talk key, or a
conversation turn you switched on); there is no wake word, capture is hard-capped, audio is
held in memory and never written to disk, and a mis-heard transcript is still just a prompt —
every tool call it leads to hits the same permission gate as anything you type. Recording
needs a capture tool on PATH: `sox` anywhere, or `arecord`/`parecord`/`ffmpeg` on Linux,
`ffmpeg` on macOS. Everything is stored in `~/.privateer/speak.json`; the engine itself is the
standalone [`privateer-speak`](https://www.npmjs.com/package/privateer-speak) package, usable
in any Pi agent.

## The Privateer app

The same account drives Privateer from **iOS, Android, [the web app](https://privateer.pro),
and a desktop app**. The terminal stays where the work happens — the app is a remote control
and a management surface for it.

### Linking a terminal

1. Run **`privateer`** and **`/signin`**. Your browser opens an authorize page — check the
   code matches the terminal's and click **Authorize**. (No browser handy? The terminal also
   prints the link and code: open the app → **Link a terminal** and enter it there.) No
   password or wallet key ever touches the terminal, and the app pins the terminal's public
   key on first link.
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

Once it's installed, **`/desktop`** in the terminal brings it up — no Spotlight detour. It
opens the app, not a copy of this conversation: the desktop hosts its own session, so pick
the folder you were working in from **File ▸ Spawn Privateer at…** and it starts on the same
model and connectors this terminal uses (the per-folder defaults live in `~/.privateer`,
which both read).

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

## Drive it from Buzz or Zed — ACP

Privateer speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP v1 over
stdio). Any ACP host — [Buzz](https://buzz.xyz), Block's team messenger where agents are
teammates, or the [Zed](https://zed.dev) editor — can spawn `privateer acp` and drive it:
prompts stream back, tool activity shows live, and the host's model picker lists Privateer's
catalog with TEE-backed models labelled **confidential (TEE)**.

The part we care about: **the host renders the UI, but authority never leaves your machine.**

- Every action is classified by Privateer's own permission gate — ACP's
  `session/request_permission` only delivers the prompt.
- The **tool ceiling** comes from your local config, not the host, and ships **read-only**
  (`read`, `grep`, `find`, `ls`). The host cannot widen it.
- Filesystem access is **confined to one directory root**; out-of-tree access is refused,
  not prompted.
- Every ambiguous outcome — unreachable host, cancelled dialog, unknown answer, aborted
  turn — resolves to **deny**.
- "Allow for this session" lives in memory and dies with the session; dangerous shell
  (`curl … | sh` and friends) can never become standing permission.

Zed setup (`settings.json`):

```json
{ "agent_servers": { "Privateer": { "command": "privateer", "args": ["acp"] } } }
```

Honest caveat for Buzz: **Buzz currently auto-approves permission prompts**, so under Buzz
the tool ceiling *is* the control — which is exactly why the default is read-only. Full
setup, config, and limitations: [`docs/acp.md`](docs/acp.md).

## Connectors — MCP

Privateer is an **MCP client**. Point it at a [Model Context Protocol](https://modelcontextprotocol.io)
server and that server's tools become first-class agent tools, gated exactly like the
built-ins. Two kinds:

| | |
|---|---|
| **Local — `stdio`** | Privateer spawns the server as a child process on this machine. Nothing leaves the box except what that server itself chooses to send. |
| **Remote — `http`** | An `https` endpoint somebody else hosts. It authenticates with `oauth` (you authorize in a browser on **this** machine), a static `bearer` token, or nothing at all. Whatever the agent hands that server leaves your machine — the app shows a "sends data to *host*" badge for exactly this reason. |

### Add one

```
/connect        # add, enable, disable, or remove connectors
/mcp            # pi-mcp-adapter's own status view — what actually connected
```

`/connect` opens a picker over a curated catalog of 21 connectors — GitHub, Slack, Notion,
Linear, Jira & Confluence, Sentry, Stripe, Asana, Supabase, Figma, Gmail, Google Drive,
PostgreSQL, Playwright, Filesystem, … — plus a **Custom connector** entry for anything
else: any stdio command line, or any `https://` URL. Pick one, fill in the token or path it
asks for, and the adapter reloads in place, so the new tools are live in the session you're
already sitting in. You can do the same from [the app](#the-privateer-app) or the desktop
app; all three edit the same files.

### One config, three surfaces

```
~/.privateer/agent/mcp-desktop.json   # source of truth — every connector, each with `enabled`
~/.privateer/agent/mcp.json           # projection: enabled connectors only, in the standard
                                      # { "mcpServers": … } shape the adapter reads
```

Don't hand-edit the projection — it is rewritten from the source on every change. Edit
`mcp-desktop.json`, or just use `/connect`.

Both files live in the shared `~/.privateer` home, so a connector you add in the terminal is
already there for the harbor's unattended routine runs and for the desktop app's windows.
One machine, one coherent connector config, however you reached it.

### Tools and the moat

By default the adapter exposes MCP through a **single proxy tool named `mcp`** — one grant
covers every server you've enabled. When a routine carries a per-connector allow-list,
Privateer scopes that run down to exactly the selected servers and tools instead, each
registered under its own `<server>_<tool>` name, so an unattended task can hold GitHub's
`create_issue` without holding all of MCP.

Either way, **every MCP tool goes through the same permission gate as the built-ins.** A
tool is not trusted because you configured the server it came from.

### Credentials

A connector's secrets — env values, a bearer token, an `Authorization:` header — are written
in **plaintext** to `mcp-desktop.json` on this machine. That's unavoidable: the adapter has
to hand the real token to the server. `/connect` masks the field while you type, which is
shoulder-surfing and screen-share hygiene, not a storage claim. Protect that file the way you
protect `~/.aws/credentials`.

Editing connectors **from the app** is a different story: over the relay secrets are
write-only in both directions. A listing returns env/header *names* and which of them are
set — never a value — and a value you type on your phone is sealed to that terminal's pinned
key before it leaves the device, so the relay forwards it blind. See
[What you can do from the app](#what-you-can-do-from-the-app).

A hand-written `.mcp.json` in a project directory is a **protected path**: the agent can be
asked to edit one, but never does it silently, in any mode.

> **Hosted harbors are OAuth-only by design** — no stdio child processes, no stored tokens,
> because a hosted tenant's home is tmpfs and a durable secret would have to rest somewhere
> we could read. In the current preview they carry no connectors at all; mirroring your
> catalog into a hosted agent isn't wired up yet.

## Permission modes

| Mode | Behavior |
|---|---|
| `default` | prompt before edits and shell commands |
| `acceptEdits` | auto-approve file edits; still prompt for shell commands |
| `bypass` | no prompts (destructive commands are *still* blocked) |
| `plan` | read-only; the agent presents a plan, then you approve to proceed |

Switch with **`/mode`**. Even in `bypass`, a danger filter blocks destructive shell commands,
and protected files (`.env`, shell rc files…) are guarded — the gate is never fully off.

### No quarter — lower the moat entirely

This is the one exception to "the gate is never fully off." It disables the permission
gate for the **whole session** — every action auto-approves with no prompt, including
destructive shell commands, out-of-cwd access, and protected files. Subagents spawned
after it goes on inherit it (env `PRIVATEER_NO_QUARTER=1`). Only for a directory and a
task you fully trust.

Three ways in, all the same switch:

| | |
|---|---|
| **shift+tab** | toggle it mid-session — hit it and walk away, and the agent runs the task to the end instead of stopping at the next approval |
| `/no-quarter [on\|off]` | the typed equivalent |
| `privateer --no-quarter` | start a session with the moat already down |

It's never quietly in effect: the launch flag prints a red warning banner, the toggle
posts a warning to the transcript, and while it's on the footer carries a permanent red
`⚑ no quarter — permission gate OFF` indicator. shift+tab again raises the moat.

Toggling takes effect from the next gated action — an approval already on screen still
needs an answer. It's a physical-terminal switch: a phone driving this terminal over
`/remote-access` can't reach it. The app has its own no-quarter toggle for driven turns,
and it means the same thing this flag does: the moat down, dangerous shell and destructive
actions included — stronger than `/mode bypass`, which keeps those two above it. A hard
plan-mode deny is the one thing it doesn't talk around.

> shift+tab is Pi's default "cycle thinking level" chord; Privateer takes it for this.
> Thinking level is still under `/settings`, or bind `app.thinking.cycle` to another key
> in `~/.privateer/agent/keybindings.json`.

## Extend it

Everything below is a **Pi extension** loaded by discovery (see [Built on Pi](#built-on-pi)) —
drop your own into `~/.privateer/agent/extensions/` and it loads the same way, gated like the rest.

- **MCP servers** (`pi-mcp-adapter`) — declare them and their tools become first-class, gated
  like the rest (local stdio, or remote HTTP with interactive OAuth). Add them with
  `/connect`; see [Connectors — MCP](#connectors--mcp).
- **Sub-agents** (`pi-subagents`) — delegate investigations to bounded parallel agents. Children
  run as headless child processes that **inherit the moat**, so their actions hit the same
  permission gate and their approvals surface on your phone.
- **Routines** — saved tasks the harbor runs unattended; ask the agent to schedule work and
  approve it once.
- **Workflows** — declarative multi-step pipelines the harbor executes; see
  [Workflows](#workflows).
- **Web tools** (`privateer-web`) — `web_search` and `web_fetch`, by one of two routes. Sign in
  and they run on your Privateer account: no API key to obtain or keep on the machine, metered
  against the account's daily web allowance, with the search itself made server-side (the derived
  query is visible to Privateer — the page you fetch and the conversation around it are not).
  Configure a provider of your own with `/web-tools` and that wins instead — `rpiv-web-tools` with
  pluggable backends, including self-hosted SearXNG for fully private search, which is why a
  provider you chose is never overridden. `PRIVATEER_WEB_SEARCH=privateer` picks the account route
  even when you hold a key. Unattended runs (harbor, channels, ACP) always take the account route:
  a routine must not hold a provider key it could be prompt-injected into leaking.
- **Ask user question** (`rpiv-ask-user-question`) — when a request is underspecified the agent
  raises a structured questionnaire (typed options, multi-select, markdown previews, or type your
  own answer) instead of guessing. Ungated by design — it only asks you something.

## Command reference

| Command | What it does |
|---|---|
| `/model` · `/models` | switch model; `/models` is a searchable picker with TEE/ZDR privacy shields |
| `/mode` | switch permission mode |
| `/no-quarter` | lower the moat for this session and run unattended (**shift+tab**) |
| `/verify` | fetch and check the TEE attestation for the current model |
| `/signin` · `/signout` | sign in to a Privateer account (device flow) / sign out |
| `/remote-access` | link this terminal to the app and allow it to drive (off by default) |
| `/connect` · `/mcp` | add, enable, or remove MCP connectors / see what actually connected |
| `/speak` · `/talk` | read answers aloud / voice input (**alt+t** is push-to-talk) |
| `/extensions` | list loaded Pi extensions |
| `/web-tools` | point `web_search`/`web_fetch` at a search provider of your own (signed in, they already work on your account) |
| `/init` | scaffold a starter `PRIVATEER.md` in this directory |
| `/desktop` | open the [desktop app](#desktop-app) — same login, same per-folder defaults |
| `/update` · `/privateer` | update to the latest release / Privateer status and posture |

Shell subcommands: `privateer` (interactive), `privateer update`, `privateer harbor …`,
`privateer acp` (serve the agent to an ACP host like Buzz or Zed — see
[`docs/acp.md`](docs/acp.md)), `privateer --no-quarter`, `privateer --version`.

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
