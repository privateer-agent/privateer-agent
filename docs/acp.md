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
| `posture` | `approve` | `readonly` — plan mode, remote asks are denied outright, never prompted. `approve` — the host renders each ask. `auto` — non-dangerous actions run unattended; dangerous shell and destructive tools still come back to the host as asks (weaker than `--no-quarter`, which clears those too). |
| `cwd` | the process's spawn cwd | **The confinement root** for both tools and the permission gate. |

### ⚠️ The cwd footgun

If `acp.cwd` is unset, the confinement root is **whatever directory the host spawned the
process from**. A host that spawns agents from `$HOME` or `/` gives the agent a very broad
read scope. Set `acp.cwd` explicitly to the project you want the agent confined to.

The root is process-wide, not per-session, by design: the gate and the tools must agree on
one root. The `cwd` a host offers in `session/new` is accepted but does not move the
confinement root.

## Driving Privateer from another agent

ACP is the right surface when **a program, not a person, is in charge of the run**: an
orchestrator agent, a CI job, a script that hands Privateer a task and needs to answer its
questions. Pick by one thing — does anything need approving?

| You want to… | Use |
|---|---|
| Run a task that needs no approvals (reads, or writes already allowed) | `privateer -p "…"` |
| Let a one-shot run spend on named billing tools, capped | `privateer -p --allow-spend generate_video --max-calls 1 --max-spend 1.00 "…"` |
| Have a person approve from their phone while a one-shot runs | `privateer -p --approve-in-app "…"` |
| **Have your program answer each approval itself** | `privateer acp` (this page) |

A `-p` run with none of those flags **denies** every approval, because nobody is there to
ask. It says so at startup (on stderr) and in the model's instructions, so neither you nor
the model finds out at the last step.

### The session, on the wire

Your program spawns `privateer acp` and speaks ACP v1 — newline-delimited JSON-RPC over the
child's stdin/stdout. Everything Privateer logs goes to **stderr**; stdout is only the protocol.

```text
you → initialize          { protocolVersion: 1, clientCapabilities: {} }
you → session/new         { cwd, mcpServers: [] }            ← returns sessionId + model list
you → session/prompt      { sessionId, prompt: [{ type: "text", text: "…" }] }
    ← session/update      agent_message_chunk / tool_call / tool_call_update (streamed)
    ← session/request_permission   ← when the gate needs a decision (below)
you → (answer it)
    ← session/prompt result { stopReason: "end_turn" | "cancelled" | … }
```

### How a permission request reaches you

When Privateer's gate decides an action needs a decision, the running `session/prompt` is
**suspended** and Privateer sends your program a `session/request_permission` **request**
(a JSON-RPC call with an `id` — it expects a reply):

```json
{
  "jsonrpc": "2.0", "id": 7, "method": "session/request_permission",
  "params": {
    "sessionId": "…",
    "toolCall": {
      "toolCallId": "perm-5f0c…",
      "title": "Generate a video (billed to your Privateer account) — clips/intro.mp4",
      "kind": "edit",
      "status": "pending",
      "rawInput": { "tool": "generate_video", "detail": "clips/intro.mp4", "path": "/work/clips/intro.mp4" }
    },
    "options": [
      { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
      { "optionId": "deny",  "name": "Deny",  "kind": "reject_once" }
    ]
  }
}
```

Reply with the option you chose:

```json
{ "jsonrpc": "2.0", "id": 7, "result": { "outcome": { "outcome": "selected", "optionId": "allow" } } }
```

- **`toolCall.title`** is a one-line human summary; **`rawInput.tool`** is the tool name to
  make policy decisions on, `detail` the command or path, `path` the absolute target if any.
  `kind` is ACP's vocabulary: `read`, `edit`, `execute` (shell), `fetch`, `other`.
- **Options vary per request.** `always` ("Allow for the rest of this session") is offered only
  when it is safe to remember. It is never offered for billed tools, protected files, or
  dangerous shell. Answer only with an `optionId` you were offered.
- **Anything else is a denial.** `{ "outcome": { "outcome": "cancelled" } }`, an unknown
  `optionId`, an error response, or a dropped connection all deny. The model is told the action
  was denied and not to retry it.
- **There is no timeout on Privateer's side.** The turn waits for your answer. To give up,
  send `session/cancel` for that session and answer the pending request with
  `{ "outcome": { "outcome": "cancelled" } }` (the ACP spec requires the client to). The action
  is denied and the turn ends with `stopReason: "cancelled"`.
- **`always` is scoped to the session.** It lives in memory for that one ACP session and is
  never written to disk. Another session, or the next process, asks again.
- **Requests are per session.** With several sessions open, each request carries its own
  `sessionId`. Route it to whatever is driving that session.

Which actions ask at all depends on `acp.posture`. `approve` asks for everything the gate
would ask a person. `auto` asks only for dangerous shell and destructive or billed actions.
`readonly` never asks and denies instead.

### Billed tools over ACP

Media generation is off the ACP tool list unless you add it: list the tools in `acp.tools`
(e.g. `"generate_video", "media_capabilities"`) on a signed-in machine. Every billed call then
arrives as a permission request, one per call and never "always". Call `media_capabilities`
first: it reports what an image and a clip cost (per length, resolution and audio), so your
program can decide against a budget before it answers `allow`.

### A minimal Node client

```js
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@zed-industries/agent-client-protocol";

const child = spawn("privateer", ["acp"], { stdio: ["pipe", "pipe", "inherit"] });
const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));

const conn = new ClientSideConnection(() => ({
  async sessionUpdate({ update }) {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") process.stdout.write(update.content.text);
  },
  // Every approval Privateer needs lands here. Decide, then answer with an offered optionId.
  async requestPermission({ toolCall, options }) {
    const ok = toolCall.rawInput?.tool !== "generate_video" || budgetAllows(toolCall);
    const pick = options.find((o) => o.optionId === (ok ? "allow" : "deny"));
    return { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } };
  },
  async readTextFile() { throw new Error("not supported"); },
  async writeTextFile() { throw new Error("not supported"); },
}), stream);

await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
const { sessionId } = await conn.newSession({ cwd: process.cwd(), mcpServers: [] });
const { stopReason } = await conn.prompt({ sessionId, prompt: [{ type: "text", text: "Make a 6s intro clip" }] });
console.error("\nturn ended:", stopReason);
child.stdin.end(); // closing stdin shuts Privateer down cleanly
```

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
and verified live against a real host and a real model.

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
- **A turn fails with "Connection error." or "401 …"** — the error now carries a hint saying
  what was refused and what to do. On the account channel a refused session is renewed on the
  next turn; if every turn still fails, check `privateer auth status` on that machine.
- **Every action is denied and no prompt appears anywhere** — the agent is running with a
  second, unattached permission gate in front of ours. Run the stock `privateer acp`
  entry point rather than loading the agent into a custom Pi session with discovered
  extensions enabled.
- **The agent can read files you didn't expect** — you didn't set `acp.cwd` and the host
  spawned from a broad directory. Set `acp.cwd`.
- **The agent refuses to write anything** — that's the default. Raise `acp.tools` in
  `~/.privateer/config.json` on the machine that runs the agent.
