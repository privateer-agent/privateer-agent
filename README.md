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
`/todo` `/compact` `/doctor` `/clear` `/exit`

- `/init` — the agent explores the repo and writes a `PRIVATEER.md` for you
  (`/init --stub` just drops an empty template, no model call).
- `/todo` — print the agent's current task list.
- `/compact` — summarize older history to reclaim context (also happens automatically).

While the agent is working, press **Esc** to interrupt the turn (partial output is kept);
**Ctrl-C** quits.

## Tools

`read` · `write` · `edit` · `glob` · `grep` · `bash` · `todo` · `task` ·
`web_fetch` · `web_search`

The file/search/shell tools are pure-Node (no external binaries required). Mutating tools
(write/edit/bash) and network tools (web_fetch/web_search) go through the permission gate.
`todo` maintains the live task list; `task` delegates an investigation to a read-only
sub-agent that returns a summary.

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

## Caveats

Privateer ports Claude Code's design *patterns* onto a provider-agnostic core; a few are
deliberately simplified:

- **Prompt caching is Anthropic-only.** Ephemeral cache breakpoints are attached for direct
  Anthropic models and OpenRouter routes to `anthropic/*`. Other providers ignore them (a
  harmless no-op).
- **Sub-agents are synchronous.** A `task` runs one read-only child agent to completion and
  returns its summary — there's no parallel worker fan-out.
- **Compaction is heuristic.** Context size is estimated (~4 chars/token) and older history is
  summarized by a one-shot generate, not a structured-output schema. The most recent messages
  are always kept verbatim.
- **`web_search` scrapes DuckDuckGo's keyless HTML endpoint.** It needs no API key but is
  best-effort and can break if their markup changes. `web_fetch` is robust for known URLs.
- **Protected files** (`.env`, `.npmrc`, shell rc files, …) always prompt before edit — except
  in `bypass` mode, which by definition skips all prompts.

## Docs

- [Architecture](docs/ARCHITECTURE.md) — how the provider layer, agent loop, tools, and permissions fit together
- [Brand assets](brand/README.md) — the logo and icon set

## License

[MIT](LICENSE) © Patrick
