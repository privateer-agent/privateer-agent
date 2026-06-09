<p align="center">
  <img src="brand/privateer_logo.png" alt="Privateer" width="140" />
</p>

<h1 align="center">⚓ Privateer</h1>

<p align="center">
  <strong>A provider-agnostic terminal coding agent — bring your own model.</strong>
</p>

<p align="center">
  <a href="https://github.com/privateer-agent/privateer-agent/actions/workflows/ci.yml">
    <img src="https://github.com/privateer-agent/privateer-agent/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  <img src="https://img.shields.io/badge/providers-OpenRouter%20·%20Anthropic%20·%20OpenAI%20·%20Ollama-5b8def" alt="Providers" />
  <img src="https://img.shields.io/badge/built%20on-Vercel%20AI%20SDK-black" alt="Vercel AI SDK" />
</p>

Switch between **OpenRouter**, **Anthropic**, **OpenAI**, and local **Ollama** with one
command. Built on the Vercel AI SDK, so tool-calling and streaming work identically across
every provider — no model lock-in, no separate code paths.

<p align="center">
  <img src="docs/screenshot.png" alt="Privateer running in the terminal" width="820" />
</p>

## Why Privateer?

- **No lock-in.** Point it at a frontier model today and a local Ollama model tomorrow —
  `/model` swaps mid-session. Your config, commands, and agents come along for the ride.
- **The agent UX you already know.** Plan mode, checkpoint/rewind, a modal prompt, slash
  commands, sub-agents, and project memory — but vendor-neutral.
- **Genuinely extensible.** MCP servers, lifecycle hooks, custom commands, output styles,
  and sub-agents are all just files under `.privateer/`. No plugins to compile.
- **Zero binary deps.** The file/search/shell tools are pure Node — nothing to install
  beyond `node`.

## Highlights

- A modal prompt with `/` command and `@` file autocomplete, `!` shell passthrough,
  `#` memory append, input history, optional **vim** mode, and **ctrl-r** history search
- Layered `settings.json` (user → project → local → managed), **custom slash commands**
  and **output styles** as markdown files
- **Plan mode** (read-only → present a plan → approve), **checkpoint/rewind** of
  conversation and files
- Extensible: **MCP servers**, lifecycle **hooks**, and **custom sub-agents**
- Background shells, bounded parallel sub-agents, thinking display, structured compaction,
  and image attachment for vision-capable models

## Quickstart

```bash
git clone https://github.com/privateer-agent/privateer-agent.git
cd privateer-agent
npm install
export OPENROUTER_API_KEY=sk-or-...     # one provider is enough
npm start                               # launches the interactive TUI
```

First run walks you through picking a provider and default model. From there, just type.

## Contents

- [Requirements](#requirements) · [Install](#install) · [Configure a provider](#configure-a-provider) · [Model routing](#model-routing) · [Usage](#usage)
- [The prompt](#the-prompt) · [Slash commands](#slash-commands) · [Tools](#tools)
- [Customize & extend](#customize--extend) · [Permission modes](#permission-modes) · [Project context](#project-context)
- [Develop](#develop) · [Caveats](#caveats) · [Docs](#docs) · [License](#license)

## Requirements

- Node.js ≥ 20
- An API key for at least one provider (or a local Ollama install)

## Install

```bash
npm install        # install dependencies
npm link           # optional: put `privateer` on your PATH
```

Or run directly without linking:

```bash
npm start          # launches the interactive TUI
# or
node bin/privateer.mjs
```

## Configure a provider

Privateer reads credentials from environment variables or a config file.

**Env vars (quickest):**

```bash
export OPENROUTER_API_KEY=sk-or-...      # gateway to ~everything
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export OLLAMA_BASE_URL=http://localhost:11434/api   # optional; defaults to this
```

**Config file** — `~/.privateer/config.json` (global) and/or `./.privateer/config.json` (per project):

```json
{
  "defaultModel": "openrouter:anthropic/claude-opus-4.8",
  "permissionMode": "default",
  "providers": {
    "openrouter": { "apiKey": "sk-or-..." },
    "anthropic":  { "apiKey": "sk-ant-..." }
  }
}
```

Override the config location with `PRIVATEER_HOME`.

## Model routing

`defaultModel` handles most turns, but it's often the wrong tool for a particular one —
it may not accept the file you dropped in, or you'd rather spend a cheaper model on a
trivial question. The optional **`router`** block lets Privateer switch models per turn
based on the turn's **data type** and shape:

```json
{
  "defaultModel": "openrouter:minimax/minimax-m3",
  "router": {
    "vision":   "openrouter:google/gemini-2.5-flash",
    "document": "openrouter:anthropic/claude-opus-4.8",
    "audio":    "openrouter:google/gemini-2.5-flash",
    "video":    "openrouter:google/gemini-2.5-flash",
    "long":     "openrouter:anthropic/claude-opus-4.8",
    "fast":     "openrouter:openai/gpt-4o-mini",
    "longThreshold": 60000,
    "fastMaxChars": 280,
    "inlineTextMaxBytes": 65536,
    "auto": true
  }
}
```

Reference a file in the prompt — drag-drop, paste a path, or `@`-mention — and Privateer
classifies it by **modality** and routes accordingly:

| Route | Chosen when the turn (or conversation) includes… |
|---|---|
| **vision** | an image (`.png .jpg .jpeg .gif .webp`) |
| **document** | a PDF (`.pdf`) |
| **audio** | audio (`.mp3 .wav .m4a .ogg .flac`) |
| **video** | video (`.mp4 .mov .webm .mkv`) |
| **long** | the estimated context exceeds `longThreshold` tokens (default: half of `contextBudget`) |
| **fast** | the prompt is ≤ `fastMaxChars` characters (and needs no attachment) |
| **default** | everything else (`defaultModel`) |

Each attached file collapses to a chip — `[Image #1]`, `[PDF #2]`, `[Audio #3]`,
`[Video #4]` — while the file itself rides along to the model. **Code/CSV/markdown and
other text files aren't routed**: they're read and inlined into the prompt (up to
`inlineTextMaxBytes`; larger ones are left as a path for the agent's read tool).

**Capability requirements outrank `long`/`fast`.** A turn that needs a modality is
routed to a model that can actually accept it — and routing is **sticky**: once a file
is in the conversation, later turns stay on a capable model so the attachment is never
replayed to one that can't read it. A turn that needs **several** modalities at once
(say an image *and* a PDF) is routed to a model whose support covers all of them. When
a turn is routed, the transcript shows a line like `↪ routed to gemini-2.5-flash ·
image input`.

**Hybrid auto-detect** (`"auto": true`, the default): if you reference, say, a PDF but
haven't set `router.document`, and your `defaultModel` can't read PDFs, Privateer
auto-selects a capable model from a configured provider. Set the route explicitly to
control exactly which model is used, or `"auto": false` to disable it (you'll get a
one-line warning when nothing can handle the modality).

## Usage

```bash
privateer                                   # interactive TUI with the default model
privateer -m openrouter:anthropic/claude-opus-4.8
privateer -c                                # resume the last session in this dir
privateer -p "summarize src/"               # headless one-shot, prints to stdout
```

Run `/model` (no argument) to browse the models each configured provider actually
offers — the list is fetched live using the API key you entered, then filtered as you
type. Onboarding ends on the same picker so you choose your default model up front.

You can also pass a model string directly as `provider:model`:

| Example | |
|---|---|
| `openrouter:anthropic/claude-opus-4.8` | any model on OpenRouter |
| `anthropic:claude-opus-4-8` | direct Anthropic |
| `openai:gpt-5.5` | direct OpenAI |
| `ollama:qwen3-coder` | local model |

## The prompt

The input is modal — the first character chooses what happens:

| Prefix | Mode |
|---|---|
| _(text)_ | a normal prompt to the model |
| `/` | a slash command — opens an autocomplete menu |
| `@` | a file mention — fuzzy-completes paths from the cwd |
| `!` | run a shell command locally and show its output (no model turn) |
| `#` | append the rest of the line to `PRIVATEER.md` |

Also: **↑/↓** history, **ctrl-r** reverse history search, emacs line editing
(`ctrl-a/e/u/w`), `ctrl-l` to clear the screen, and **`\`+Enter** for a newline. Messages
typed while the agent is busy are queued and run in order. `/vim` toggles modal (vim)
editing. Reference an image file to attach it for vision-capable models — by `@`-mention
(`@screenshot.png`), or by pasting a path anywhere in the prompt. Absolute paths and paths
with spaces work too, quoted (`"/Users/me/My Shot.png"`) or backslash-escaped
(`/Users/me/My\ Shot.png`); a leading `/path/...` is treated as a file, not a command. Each
referenced image collapses to a short `[Image #1]` chip in the transcript (numbered across
the session) while the picture itself rides along to the model.

While the agent is working, press **Esc** to interrupt the turn (partial output is kept);
**Ctrl-C** quits.

## Slash commands

Built-ins (plus any custom commands you add):

| Command | |
|---|---|
| `/help` `/doctor` `/config` | help, diagnostics, resolved settings layers |
| `/model [spec]` `/provider` `/login` | choose a model, list providers, re-run onboarding |
| `/permissions [mode]` `/cost` `/context` | permission mode, token usage, context window |
| `/init` `/memory` | write/show `PRIVATEER.md` |
| `/agents` `/mcp` `/hooks` | inspect custom sub-agents, MCP servers, hooks |
| `/output-style [name]` `/vim` `/verbose` | persona, modal editing, full tool output |
| `/rewind` `/compact` `/clear` `/export` | restore a checkpoint, compact, clear, save transcript |
| `/exit` | quit |

- `/model` — open a picker of each provider's live models (or `/model provider:id` to set one directly).
- `/init` — the agent explores the repo and writes a `PRIVATEER.md` for you
  (`/init --stub` just drops an empty template, no model call).
- `/rewind` — pick an earlier checkpoint and restore the conversation, the files, or both.
- `/compact` — summarize older history to reclaim context (also happens automatically).

## Tools

`read` · `write` · `edit` · `glob` · `grep` · `bash` · `bash_output` · `kill_shell` ·
`todo` · `task` · `web_fetch` · `web_search` — plus any tools exposed by connected MCP servers.

The file/search/shell tools are pure-Node (no external binaries required). Mutating tools
(write/edit/bash) and network tools (web_fetch/web_search, MCP) go through the permission gate.
`todo` maintains the live task list; `task` delegates an investigation to a sub-agent that
returns a summary. `bash` can run detached with `run_in_background`; `bash_output` polls a
background shell's new output and `kill_shell` stops it.

## Customize & extend

Everything below is optional and lives under `.privateer/` (project) or `~/.privateer/`
(user); project files win. Settings merge across `config.json` → `settings.json` →
`settings.local.json` (run `/config` to see the resolved chain).

- **Custom commands** — `.privateer/commands/<name>.md`. The body is a prompt template
  (`$ARGUMENTS`, `$1`…`$9`); optional frontmatter sets `description`/`argument-hint`. They
  appear in `/help` and `/` autocomplete; subfolders namespace as `dir:name`.
- **Output styles** — `.privateer/output-styles/<name>.md` swap the agent's persona.
  Switch with `/output-style <name>` (or `default`).
- **Sub-agents** — `.privateer/agents/<name>.md` with frontmatter (`description`, `tools`,
  `model`). Invoke via the `task` tool's `subagent_type`; `/agents` lists them.
- **Hooks** — a `hooks` section in `settings.json` runs shell commands on `PreToolUse`,
  `PostToolUse`, `UserPromptSubmit`, and `Stop`. A hook blocks by exiting `2` or printing
  `{"decision":"block"}`; `UserPromptSubmit` can inject `additionalContext`. `/hooks` lists them.
- **MCP servers** — declare them in `.privateer/mcp.json` (`{ "mcpServers": { … } }`,
  stdio transport). Their tools are namespaced `server__tool` and gated like the rest;
  `/mcp` shows connection status.
- **Status line** — set `statusLine` to a shell command; it receives session JSON on stdin
  and its stdout becomes the status line.

## Permission modes

| Mode | Behavior |
|---|---|
| `default` | prompt before edits and shell commands |
| `acceptEdits` | auto-approve file edits; still prompt for other shell commands (the default) |
| `bypass` | no prompts (also `--dangerously-skip-permissions` or `--no-quarter`) |
| `plan` | read-only; the agent presents a plan, then you approve to leave plan mode |

At an approval prompt: **y** allow once · **a** always · **n** deny. In plan mode, after the
agent presents its plan: **a** approve and exit plan mode · **k** keep planning.

## Project context

Create a `PRIVATEER.md` in your repo (via `/init`) to give the agent standing
context — conventions, architecture notes, anything it should always know.

## Develop

```bash
npm run typecheck
npm test
```

## Caveats

Privateer's agent core is built provider-agnostic from the ground up; a few areas are
deliberately simplified for now:

- **Prompt caching and extended thinking are Anthropic-only.** Ephemeral cache breakpoints
  and the `thinkingBudget` setting apply to direct Anthropic models and OpenRouter routes to
  `anthropic/*`. Other providers ignore them (a harmless no-op).
- **Checkpoints are in-memory.** `/rewind` is a within-session undo; snapshots live in memory
  and aren't persisted across restarts.
- **MCP is stdio-only.** Servers are launched as local processes; HTTP/SSE transport isn't
  wired up yet.
- **Image attachment assumes vision support.** Referenced images are sent as content parts;
  non-vision models will return an error.
- **Compaction estimates context size** (~4 chars/token). The summary itself is
  schema-guided (goals / decisions / files / open threads), with a plain-text fallback, and
  the most recent messages are always kept verbatim.
- **`web_search` scrapes DuckDuckGo's keyless HTML endpoint.** It needs no API key but is
  best-effort and can break if their markup changes. `web_fetch` is robust for known URLs.
- **Protected files** (`.env`, `.npmrc`, shell rc files, …) always prompt before edit — except
  in `bypass` mode, which by definition skips all prompts.

## Docs

- [Architecture](docs/ARCHITECTURE.md) — how the provider layer, agent loop, tools, and permissions fit together
- [Brand assets](brand/README.md) — the logo and icon set

## License

[MIT](LICENSE) © Patrick
