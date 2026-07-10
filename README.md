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
curl -fsSL https://privateer.pro/install.sh | sh    # installs the `privateer` command
npx privateer-agent                                 # or run it instantly, nothing installed
```

Point it at a frontier model today and a local Ollama model tomorrow — **OpenRouter**,
**Anthropic**, **OpenAI**, **Google**, **xAI**, **Groq**, **Mistral**, **Z.ai** (GLM),
**DeepSeek**, **Qwen**, local **Ollama**, **NEAR AI** or **Tinfoil** (verifiable TEE
inference), **Venice** / **Fireworks** (no-retention inference), and any **custom
OpenAI-compatible endpoint** (LM Studio, vLLM, llama.cpp…) are interchangeable at
`/model` time, including mid-session. No model lock-in, no separate code paths. MCP
servers, sub-agents, scheduled routines, and one-tap approval from your phone are
included — and every one of the agent's actions runs through a **safe-by-default
permission gate**.

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
- **Approve it from your phone.** Link the terminal to the Privateer app with
  `/remote-access` (off by default) and Allow/Deny every action remotely while execution
  stays on your machine — supervise long agent runs from anywhere.
- **Scheduled routines.** A background daemon runs approved tasks unattended — cron or
  one-off — and the agent can schedule its own follow-up work. Results deliver to a file,
  the next session, your phone, email, or a webhook.
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
npm install -g privateer-agent          # installs the `privateer` command
# or run it without installing:
npx privateer-agent
# or the one-liner installer (verifies Node, then installs globally):
curl -fsSL https://privateer.pro/install.sh | sh
```

**Requirements:** macOS or Linux, Node.js ≥ 22.19.0.

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

## Approve from your phone

Turn on **`/remote-access`** (off by default) to link this terminal to the Privateer app. The
app can then drive the terminal — prompts come down, and each proposed action goes up for
**Allow/Deny** — while execution stays on your machine. The relay is live-only (nothing is
archived), carries no keys, and output is size-truncated and run through a best-effort secret
redactor before it leaves.

## Permission modes

| Mode | Behavior |
|---|---|
| `default` | prompt before edits and shell commands |
| `acceptEdits` | auto-approve file edits; still prompt for shell commands |
| `bypass` | no prompts (destructive commands are *still* blocked) |
| `plan` | read-only; the agent presents a plan, then you approve to proceed |

Switch with **`/mode`**. Even in `bypass`, a danger filter blocks destructive shell commands,
and protected files (`.env`, shell rc files…) are guarded — the gate is never fully off.

## Extend it

Everything below is a **Pi extension** loaded by discovery (see [Built on Pi](#built-on-pi)) —
drop your own into `~/.privateer/agent/extensions/` and it loads the same way, gated like the rest.

- **MCP servers** (`pi-mcp-adapter`) — declare them and their tools become first-class, gated
  like the rest (local stdio, or remote HTTP with interactive OAuth).
- **Sub-agents** (`pi-subagents`) — delegate investigations to bounded parallel agents that run
  under the same permission gate.
- **Routines** — saved tasks the daemon runs unattended; ask the agent to schedule work and
  approve it once.
- **Web tools** (`rpiv-web-tools`) — private-by-default web search/fetch with pluggable backends
  (self-hosted SearXNG for fully private search).

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
