# Privateer — Architecture

Privateer is a terminal coding agent built around one idea: **the model provider is a
swappable detail.** Everything above the provider layer — the agent loop, tools, UI,
permissions — is provider-agnostic, because the [Vercel AI SDK](https://ai-sdk.dev)
normalizes tool-calling and streaming across providers.

```
                 ┌──────────────────────────────────────────┐
   keypresses →  │              Ink TUI (App.tsx)             │  → frames
                 │  Banner · Transcript · ToolCallView ·      │
                 │  StatusBar · ApprovalPrompt · PromptInput  │
                 └───────────────┬───────────────┬────────────┘
                                 │ EngineEvents  │ approvals
                                 ▼               ▲
                 ┌──────────────────────────────────────────┐
                 │            QueryEngine (engine/)           │
                 │  streamText({ tools, stopWhen }) loop      │
                 │  → normalized EngineEvents + usage         │
                 └───────┬───────────────────┬───────────────┘
                         │ model             │ tool.execute()
                         ▼                   ▼
        ┌────────────────────────┐   ┌───────────────────────────┐
        │  providers/ (registry) │   │  tools/ (read/write/edit/  │
        │  provider:model →      │   │  glob/grep/bash)           │
        │  AI SDK LanguageModel  │   │  each gated by permissions │
        └────────────────────────┘   └───────────────────────────┘
```

## The provider layer (`src/providers/`)

The heart of the project. A model is named `provider:model`:

- `openrouter:anthropic/claude-opus-4.8`
- `anthropic:claude-opus-4-8`
- `openai:gpt-5.5`
- `ollama:qwen3-coder`

`resolve.ts` parses the spec (splitting on the **first** `:`, so model ids may contain
`/` and `:`), validates the provider is known and has credentials, then `registry.ts`
builds the matching AI SDK `LanguageModel`. Adding a provider = adding one factory entry.
Construction is offline; the network is only touched when the model actually runs.

## The agent loop (`src/engine/QueryEngine.ts`)

Each user turn calls `streamText({ model, system, messages, tools, stopWhen:
stepCountIs(maxSteps), abortSignal })`. The AI SDK runs the **multi-step tool loop
internally** — calling our tools' `execute()` and feeding results back — while
`QueryEngine` consumes `result.fullStream` and translates raw stream parts into a small,
UI-friendly `EngineEvent` union (`text`, `reasoning`, `tool-call`, `tool-result`,
`tool-error`, `step-finish`, `aborted`, `compacted`, `finish`, `error`). Conversation
history and token usage live on the engine instance, so follow-up turns keep context. A
quick Q&A and a long autonomous run are the same loop with a different step budget.

**Interruption.** `send(text, signal)` forwards an `AbortSignal`; pressing **Esc** in the
TUI aborts the in-flight turn. Whatever assistant/tool output completed is still persisted
to history (the engine falls back to a synthetic assistant message when the SDK can't hand
back a structured response), so context isn't lost.

**Prompt caching.** For Anthropic-family models the engine attaches ephemeral
`cache_control` breakpoints (one stable, one rolling) so the system prompt, tool schemas,
and history prefix are cached. `session.ts` only enables this for `anthropic` and
`openrouter:anthropic/*`; elsewhere it's a no-op.

**Compaction.** Before each turn the engine estimates context size (~4 chars/token) and, if
it crosses `contextBudget × compactRatio`, summarizes the older messages into a single
briefing while keeping the most recent ones verbatim (the cut always lands on a `user`
message, so tool-call/result pairs are never orphaned). `/compact` triggers the same path
manually.

## Tools (`src/tools/`)

Each tool is a self-contained AI SDK `tool({ description, inputSchema, execute })`:

| Tool | Notes |
|---|---|
| `read` | line-numbered, offset/limit |
| `write` | creates dirs; gated; flags protected files |
| `edit` | exact-string replace, unique-match guard; gated; flags protected files |
| `glob` | pure-Node walk + `picomatch` |
| `grep` | pure-Node regex search |
| `bash` | shell exec with timeout; gated |
| `todo` | maintains the session task list (TodoStore → TUI panel); not gated |
| `task` | spawns a read-only sub-agent and returns its summary |
| `web_fetch` | fetches a URL, strips HTML to text; gated (`fetch` kind) |
| `web_search` | DuckDuckGo keyless HTML search; gated (`fetch` kind) |

`glob`/`grep` are deliberately **pure-Node** (no ripgrep dependency) so Privateer runs
anywhere. Mutating and network tools call the **permission gate** before acting; because
`execute` is async, an approval is just an `await` the UI resolves. The session passes each
tool a `ToolContext` carrying the cwd, gate, the `TodoStore`, and a `runSubAgent` runner.

**Sub-agents (`task`).** `session.ts` builds the runner: a fresh `QueryEngine` with the
**read-only** toolset (`createReadOnlyTools` — read/glob/grep, no recursion), a lower step
budget, and a report-back system prompt. It runs to completion and returns the text it
produced. This is synchronous — one sub-agent at a time, not parallel workers.

**Todo panel.** The `todo` tool rewrites the whole list into a session `TodoStore`; the TUI
subscribes to it and renders `TodoPanel` above the status bar (in-progress highlighted,
completed struck through). The list carries across model switches and is cleared by `/clear`.

## Permissions (`src/permissions/`)

`mode.ts` holds the pure policy: given a request + mode + allowlist, return
`allow`/`deny`/`ask`.

| Mode | Behavior |
|---|---|
| `default` | prompt before edits and shell |
| `acceptEdits` | auto-approve edits; still prompt for other shell |
| `bypass` | no prompts |
| `plan` | read-only; mutations denied |

`uiGate.ts` (`ModeGate`) applies the policy, and only when it yields `ask` does it surface
the Ink `ApprovalPrompt` (**y** allow · **a** always · **n** deny). The gate reads the
current mode via a getter, so changing modes never requires rebuilding the session.

**Protected files** (`permissions/protected.ts`): `write`/`edit` flag guarded targets
(`.env`, `.npmrc`, shell rc/git files, …) on the request; `decideAuto` then forces `ask`
even under `acceptEdits` or the allowlist (only `bypass` skips it). **Network reads**
(`web_fetch`/`web_search`) use a `fetch` permission kind — permitted-with-prompt even in
`plan` mode, since they don't mutate anything. `resolveInCwd` also canonicalizes the nearest
existing ancestor with `realpath` to catch symlink escapes from the cwd.

## Config & persistence (`src/config/`, `src/memory/`)

`loadConfig()` merges `~/.privateer/config.json` (global) with `./.privateer/config.json`
(project) and falls back to env vars for keys. The data dir is overridable via
`PRIVATEER_HOME`. `memory/store.ts` persists the latest conversation per project
(keyed by a hash of the cwd) so `--continue` can restore history. Config also carries the
agent loop's `maxSteps`, the `contextBudget`/`compactRatio` compaction thresholds, and the
bash `allowlist`.

## System prompt (`src/context/`)

`buildSystemPrompt` composes modular sections — identity, tone/style, security stance, and
tool-use policy (static, cache-friendly) followed by a dynamic environment block. The
environment block is grounded by `projectInfo.ts`, which runs soft, synchronous probes: a
git snapshot (branch, porcelain status, recent commits) and a capped directory listing
(reusing `walkFiles`). Both fail silently outside a repo. A `PRIVATEER.md`, if present, is
appended last so user-authored standing instructions carry the most weight.
`buildSubAgentPrompt` reuses the identity/security sections with a read-only, report-back
mandate for `task` sub-agents.

## TUI (`src/components/`)

React + [Ink](https://github.com/vadimdemedes/ink). Committed transcript lines render in
`<Static>` (write-once scrollback); the in-flight turn streams live below, followed by the
status bar and either the prompt input or an approval prompt. Model switching rebuilds the
session while carrying history forward.

## Runtime

Node ≥ 20 executed through [`tsx`](https://github.com/privatenumber/tsx) — no build step.
`bin/privateer.mjs` registers the tsx ESM loader and imports `src/main.tsx`, where
Commander parses flags and either renders the TUI or runs the headless `-p` path.

## Testing

`npm test` (Node's built-in test runner via tsx) covers tools, the engine loop (driven by
a hand-rolled `LanguageModelV2` mock — no network), slash commands, permissions, the store,
and a TUI render smoke test. `npm run typecheck` runs `tsc --noEmit`.
