# ACP — drive Privateer from Buzz, Zed, or any ACP host

`privateer acp` implements the [Agent Client Protocol](https://agentclientprotocol.com)
(ACP **v1**, newline-delimited JSON-RPC over stdio). An ACP **host** — [Buzz](https://buzz.xyz)'s
`buzz-acp`, the [Zed](https://zed.dev) editor, or anything else that speaks the protocol —
spawns the process, sends prompts, renders the streamed reply and tool activity, and
displays permission prompts.

The design rule for this surface: **the host renders the UI; your machine makes the
rules.** Everything below follows from that.

## Quickstart

```bash
npm i -g privateer-agent     # or the bundle installer — see the README
privateer acp                # a host spawns this; stdio is the transport
```

You never run `privateer acp` by hand except to smoke-test it — the host launches it.

### Zed

In Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Privateer": { "command": "privateer", "args": ["acp"] }
  }
}
```

Privateer then appears as an agent in Zed's agent panel. Zed renders Privateer's
permission prompts as real dialogs, so the `approve` posture behaves as you'd expect.

### Buzz

Buzz's agent harness (`buzz-acp`) owns the Nostr identity, transport, threading, and
mentions; it spawns Privateer as the brain behind an agent teammate. Point Buzz's agent
configuration at the `privateer` binary with the single argument `acp` (see Buzz's
managed-agents documentation for the file format — it changes on their side, not ours).

> **Honest caveat — read before deploying to a team:** Buzz currently **auto-approves**
> permission requests rather than showing a dialog. Under Buzz, `posture: "approve"`
> behaves like `auto`, and the **tool ceiling is the real control**. That is exactly why
> the default ceiling is read-only. Don't raise the ceiling for a Buzz-driven agent past
> what you'd let every member of that channel do directly.

## Configuration

The `acp` block of `~/.privateer/config.json` (the same file the harbor reads). All
fields optional:

```json
{
  "acp": {
    "model":   "openrouter/openai/gpt-4o-mini",
    "tools":   ["read", "grep", "find", "ls"],
    "posture": "approve",
    "cwd":     "/path/to/project"
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `model` | your signed-in default | Starting model. The host's model picker can switch it per session; `privateer/*` TEE models are labelled **confidential (TEE)**. |
| `tools` | `read`, `grep`, `find`, `ls` (+ web tools if web is enabled) | **Hard ceiling.** The host cannot widen it — not via `session/new`, not via anything. Media-generation tools are opt-in only (they spend your account's credit). |
| `posture` | `approve` | `readonly` — plan mode, remote asks are denied outright, never prompted. `approve` — the host renders each ask. `auto` — non-dangerous actions run unattended, like `--no-quarter`. |
| `cwd` | the process's spawn cwd | **The confinement root** for both tools and the permission gate. |

### ⚠️ The cwd footgun

If `acp.cwd` is unset, the confinement root is **whatever directory the host spawned the
process from**. A host that spawns agents from `$HOME` or `/` gives the agent a very broad
read scope. Set `acp.cwd` explicitly to the project you want the agent confined to.

The root is process-wide, not per-session, by design: the gate and the tools must agree on
one root. The `cwd` a host offers in `session/new` is accepted but does not move the
confinement root.

## The security model

What actually happens when a host drives the agent:

- **Approvals are Privateer's.** The gate classifies every action exactly as it does in
  the terminal; ACP's `session/request_permission` is only the delivery channel for the
  question. The host renders Allow / Allow-for-session / Deny — it doesn't decide.
- **Fail closed, everywhere.** No turn context → deny. Aborted turn → deny. Transport
  error → deny. Cancelled dialog → deny. Unknown option id → deny. An agent driven by
  someone else's UI degrades to *no*, never *yes*.
- **"Allow for this session" is bounded.** In-memory, scoped to that one ACP session,
  never written to disk, gone on exit. It is withheld entirely for protected files,
  always-ask actions, and dangerous shell (`curl … | sh` and friends) — those can never
  become standing permission.
- **Sessions are isolated.** Approvals are routed per-turn; a grant remembered in one
  session never applies to another.
- **Out-of-tree is refused, not prompted.** Paths outside the confinement root don't even
  generate an ask.

Covered by the ACP test suite (31 tests: protocol negotiation, streaming, cancel,
model picker, both approval outcomes, allow-always scoping, dangerous-command re-prompt),
and verified live end-to-end against a real host and a real model.

## What's on the wire

- ACP v1, ndjson JSON-RPC on stdio; `protocolVersion` negotiates down to the older side.
- Streaming: `agent_message_chunk` text, `tool_call` / `tool_call_update` with kinds
  (execute / read / edit / search / fetch).
- One turn at a time per session; `session/cancel` yields `stopReason: "cancelled"`;
  stdin EOF shuts everything down cleanly.
- `session/new` returns the model list; `session/set_model` switches in place.

## Current limitations

Stated plainly so nobody discovers them in production:

- **MCP servers offered by the host are ignored.** `session/new` may list `mcpServers`;
  they are logged and skipped. Connectors configured locally are unaffected on other
  surfaces, but they do not load on the ACP path.
- **No images or audio in prompts** — advertised as unsupported; if a host sends them
  anyway they render as `[image attached: …]` placeholders.
- **No session resume** (`loadSession: false`). The host owns durable history — under
  Buzz, the relay is the log.
- **The PII gate cannot prompt here.** There is no UI context on this path, so with the
  default `piiPolicy: "warn"` a flagged prompt is sent as-is. If that matters for your
  deployment, set `piiPolicy: "redact"` (or run with no-quarter semantics, which
  auto-redacts).
- **No egress redaction on the reply stream** (unlike the chat-app channels runtime).

## Troubleshooting

- **The host drops the connection immediately / opaque parse error** — something wrote a
  non-protocol byte to stdout. Stdout is the protocol; all diagnostics go to stderr,
  which your host captures as the agent log. If you wrapped `privateer acp` in a script,
  make sure the wrapper prints nothing.
- **Every action is denied and no prompt appears anywhere** — the agent is running with a
  second, unattached permission gate in front of ours. Run the stock `privateer acp`
  entry point rather than loading the agent into a custom Pi session with discovered
  extensions enabled.
- **The agent can read files you didn't expect** — you didn't set `acp.cwd` and the host
  spawned from a broad directory. Set `acp.cwd`.
- **The agent refuses to write anything** — that's the default. Raise `acp.tools` in
  `~/.privateer/config.json` on the machine that runs the agent.
