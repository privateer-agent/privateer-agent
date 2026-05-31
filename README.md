<p align="center">
  <img src="brand/privateer_logo.png" alt="Privateer" width="140" />
</p>

<h1 align="center">⚓ Privateer</h1>

<p align="center">
  <a href="https://github.com/zahnno/privateer-agentic-tui/actions/workflows/ci.yml">
    <img src="https://github.com/zahnno/privateer-agentic-tui/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-brightgreen" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
</p>

A provider-agnostic terminal coding agent, in the spirit of Claude Code — but you
**bring your own model**. Switch between OpenRouter, Anthropic, OpenAI, and local
Ollama with one command. Built on the Vercel AI SDK, so tool-calling and streaming
work identically across every provider.

```
    .-.
   (   )
    '+'
  ---+---       PRIVATEER
     |          bring your own model
     |
  \  |  /
   \_|_/
  (_/ \_)
```

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

## Usage

```bash
privateer                                   # interactive TUI with the default model
privateer -m openrouter:anthropic/claude-opus-4.8
privateer -c                                # resume the last session in this dir
privateer -p "summarize src/"               # headless one-shot, prints to stdout
```

Model strings are `provider:model`:

| Example | |
|---|---|
| `openrouter:anthropic/claude-opus-4.8` | any model on OpenRouter |
| `anthropic:claude-opus-4-8` | direct Anthropic |
| `openai:gpt-5.5` | direct OpenAI |
| `ollama:qwen3-coder` | local model |

## Slash commands

`/help` `/model [spec]` `/provider` `/permissions [mode]` `/cost` `/init`
`/doctor` `/clear` `/exit`

## Tools

`read` · `write` · `edit` · `glob` · `grep` · `bash` — all pure-Node (no external
binaries required). Mutating tools (write/edit/bash) go through the permission gate.

## Permission modes

| Mode | Behavior |
|---|---|
| `default` | prompt before edits and shell commands |
| `acceptEdits` | auto-approve file edits; still prompt for other shell commands |
| `bypass` | no prompts (also `--dangerously-skip-permissions`) |
| `plan` | read-only; mutations are denied |

At an approval prompt: **y** allow once · **a** always · **n** deny.

## Project context

Create a `PRIVATEER.md` in your repo (via `/init`) to give the agent standing
context — conventions, architecture notes, anything it should always know.

## Develop

```bash
npm run typecheck
npm test
```

## Docs

- [Architecture](docs/ARCHITECTURE.md) — how the provider layer, agent loop, tools, and permissions fit together
- [Brand assets](brand/README.md) — the logo and icon set

## License

[MIT](LICENSE) © Patrick
