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
message, so tool-call/result pairs are never orphaned). The summary is schema-guided via
`generateObject` (goals / decisions / files-touched / open-threads), falling back to a
plain-text generate if a model handles structured output poorly. `/compact` triggers the
same path manually.

**Thinking.** `reasoning` stream parts surface as `reasoning` events and render as dimmed
thinking blocks. The `thinkingBudget` setting enables Anthropic extended thinking
(passed as `providerOptions`); it's gated to the Anthropic family and ignored elsewhere.

## Tools (`src/tools/`)

Each tool is a self-contained AI SDK `tool({ description, inputSchema, execute })`:

| Tool | Notes |
|---|---|
| `read` | line-numbered, offset/limit |
| `write` | creates dirs; gated; flags protected files |
| `edit` | exact-string replace, unique-match guard; gated; flags protected files |
| `glob` | pure-Node walk + `picomatch` |
| `grep` | pure-Node regex search |
| `bash` | shell exec with timeout; gated; `run_in_background` for detached shells |
| `bash_output` / `kill_shell` | poll / stop a background shell (via `ProcessRegistry`) |
| `todo` | maintains the session task list (TodoStore → TUI panel); not gated |
| `task` | spawns a sub-agent (default read-only, or a named custom agent) and returns its summary |
| `web_fetch` | fetches a URL, strips HTML to text; gated (`fetch` kind) |
| `web_search` | DuckDuckGo keyless HTML search; gated (`fetch` kind) |

`glob`/`grep` are deliberately **pure-Node** (no ripgrep dependency) so Privateer runs
anywhere. Mutating and network tools call the **permission gate** before acting; because
`execute` is async, an approval is just an `await` the UI resolves. The session passes each
tool a `ToolContext` carrying the cwd, gate, the `TodoStore`, and a `runSubAgent` runner.

**Sub-agents (`task`).** `session.ts` builds the runner: a fresh `QueryEngine` with a lower
step budget and a report-back system prompt. With no `subagent_type` it uses the
**read-only** toolset (`createReadOnlyTools` — read/glob/grep, no recursion) under an
auto-approve gate. With a named custom agent (`.privateer/agents/<name>.md`) it uses that
agent's tool subset, model override, and instructions, routing any mutating tools through
the parent gate. A FIFO concurrency limiter (`util/limit.ts`, `config.maxSubagents`) bounds
how many run at once when the model fans `task` calls out.

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

`loadConfig()` deep-merges a precedence chain (`config/load.ts`): user `config.json` →
user `settings.json` → project `config.json` → project `settings.json` →
`settings.local.json` → optional managed settings, then env-var fallbacks for keys. The
schema (`config/schema.ts`) uses a catchall so forward-compatible sections (`hooks`,
`mcpServers`, `statusLine`, …) survive parsing; `config/paths.ts` centralizes the
`.privateer/` layout. The data dir is overridable via `PRIVATEER_HOME`. `memory/store.ts`
persists every conversation per project (keyed by a hash of the cwd) under its own session
id; `latest.json` mirrors the newest write so `--continue` restores history without
enumerating sessions. A session can carry a `parent` pointer (source session id +
fork-point checkpoint) — that's how branches record their lineage, and how the `/resume`
picker renders the session tree.

`memory/checkpoints.ts` powers `/rewind`: before each turn it records the conversation
length and the content of every session-modified file (write/edit call a `recordMutation`
hook that captures each file's pre-touch baseline). Restoring resolves each touched file to
its checkpoint snapshot or baseline, deleting files the session created. Snapshots are
persisted per session (a JSON index plus content-addressed blobs), so `/rewind` still works
after a restart-and-resume. Rewinding the conversation doesn't truncate in place: the app
mints a new session id, `branchTo` copies the checkpoint history (truncated at the branch
point) into the new session's directory, and the original session keeps its later turns.
`/fork` is the same branch without the rewind.

## Extensibility (`src/commands/`, `src/agents/`, `src/hooks/`, `src/mcp/`)

All of these load from `.privateer/` (project) and `~/.privateer/` (user), project winning:

- **Custom commands** (`commands/custom.ts`) — markdown files with optional frontmatter; the
  body is a prompt template (`$ARGUMENTS`/`$1`…). `runCommand` falls through to them and they
  join the `/` autocomplete list.
- **Output styles** (`context/outputStyles.ts`) — markdown personas that replace the system
  prompt's tone section while identity/security/tool-policy stay intact.
- **Sub-agents** (`agents/loader.ts`) — see the `task` runner above.
- **Skills** (`skills/loader.ts`, `tools/skill.ts`, `skills/installer.ts`) — Claude
  Code-compatible skill directories (`skills/<name>/SKILL.md` + bundled files). The `skill`
  tool embeds the name/description catalog in its description (the `task` pattern) and
  returns a skill's body on demand; loading also marks the skill directory in-scope so
  bundled files are readable. `/skills install` shallow-clones from GitHub and copies files
  only (symlinks dropped, size-capped, nothing executed).
- **Hooks** (`hooks/engine.ts`) — `PreToolUse`/`PostToolUse` wrap each tool's `execute`;
  `UserPromptSubmit`/`Stop` fire around the turn in `App`. Hooks run as shell commands with a
  JSON payload on stdin and may block (exit `2` or `{"decision":"block"}`) or inject context.
- **MCP** (`mcp/client.ts`) — a minimal stdio JSON-RPC client (initialize → tools/list →
  tools/call). Servers from `mcp.json` are connected on mount; their tools are adapted into
  namespaced, gated AI-SDK tools and merged into the session.

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
status bar and one of the prompt input, an approval prompt, the model/rewind pickers, or the
plan-confirm step. `PromptInput` is a self-contained modal editor (command/file autocomplete,
`!`/`#` modes, history, vim mode, reverse-search) — its logic mutates a single buffer state
via functional updates and reads "current mode" through refs synced during render, because
Ink's `useInput` closure can lag a render. Model/style/plan-mode changes rebuild the session
while carrying history forward.

## Runtime

Node ≥ 20 executed through [`tsx`](https://github.com/privatenumber/tsx) — no build step.
`bin/privateer.mjs` registers the tsx ESM loader and imports `src/main.tsx`, where
Commander parses flags and either renders the TUI or runs the headless `-p` path.

## Testing

`npm test` (Node's built-in test runner via tsx) covers tools, the engine loop (driven by
a hand-rolled `LanguageModelV2` mock — no network), config layering, slash and custom
commands, output styles, plan mode, checkpoints, sub-agents, hooks, the MCP client (against
a mock stdio server), the process registry, the concurrency limiter, image extraction, and
the modal prompt / TUI components. Each test file runs in its **own process** so Ink-driven
input tests don't accumulate cross-file state. `npm run typecheck` runs `tsc --noEmit`.
