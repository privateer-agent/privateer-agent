# Hand sensitive work to Privateer

Your coding agent runs on somebody else's model. Claude Code, Codex, Cursor, a CI
orchestrator: whatever it reads goes into its context, and its context goes to its
provider. Usually that's fine. Sometimes the files are patient records, a customer
export, payroll, a production database dump, a contract under NDA, and that's when it
isn't.

Privateer can act as the **private subagent** for that work. The calling agent doesn't
open the sensitive files. It hands Privateer a task that names them, Privateer reads them
on this machine and reasons over them inside an attested enclave (or on a local model),
and the caller gets back only the answer it asked for.

```text
┌─ calling agent (any model) ───────────┐        ┌─ Privateer --private ─────────────────┐
│  knows: the task, the file NAMES      │  task  │  reads the files on this machine      │
│  never opens: ./customers/*.csv       │ ─────▶ │  model: attested TEE or local only    │
│                                       │ answer │  tools: on-machine only, no network   │
│  receives: the answer, nothing else   │ ◀───── │  writes full results to local files   │
└───────────────────────────────────────┘        └───────────────────────────────────────┘
```

## Quickstart

```bash
privateer -p --private "Read customers/export.csv. Reply with the number of customers
per country, as a table. Don't include names, emails or any other row-level data."
```

That is the whole interface for most agents: one shell command, the answer on stdout.

`--private` is what turns an ordinary one-shot run into a handoff you can rely on. Without
it, Privateer would happily read the file with whatever model your config picks. With it:

| Guarantee | How it's enforced |
|---|---|
| **No file reaches an unverified model.** | Before *every* tool call, the session's model must resolve to `tee-verified` (an enclave quote Privateer checked itself) or `local` (on this machine). Anything else, including an attestation that failed or timed out, refuses the tool. |
| **Nothing leaves the machine through a tool.** | Private mode runs on an allowlist: `read`, `grep`, `find`, `ls`, `write`, `edit`, `bash`, `terminal`, `subagent`. Web, MCP, media generation, app/library uploads, routines and screen control are refused, and so is any shell command that reaches the network (`curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `git push`, `npm publish`, …). |
| **Nobody can lift it.** | The check sits above permission modes, allowlists and approvals. `--no-quarter`, `acp.posture: "auto"` and an approval from the app all leave it in place. |
| **The caller only sees the answer.** | `-p` prints the final reply and nothing else. `--private --mode json` is refused, because JSON mode streams every tool result (the file contents) to stdout. |
| **Subagents inherit it.** | `--private` reaches every gate as `PRIVATEER_PRIVATE=1`, which child processes inherit and check against their own model. |

Because `--private` can only make a run stricter, the env var is honoured from your shell
too: an orchestrator can `export PRIVATEER_PRIVATE=1` once and every Privateer it spawns is
private.

## Pick a model that passes

Private mode doesn't pick a model for you. It refuses to show files to a model it can't
verify. A model passes when its live posture is `tee-verified` or `local`:

| Model | Passes? | Why |
|---|---|---|
| `privateer/tinfoil/*`, `privateer/phala/*` (signed in) | ✅ | The request body is sealed to the enclave's attested key on this machine, so only that enclave can read it. The strongest option. |
| `privateer/near/*` (signed in) | ✅ when the quote verifies | NEAR attestation fetched through the account server and checked here. |
| `tinfoil/*` with your own `TINFOIL_API_KEY` | ✅ when the quote verifies | Attested client-side by pi-privacy. |
| A loopback endpoint (Ollama, LM Studio, llama.cpp on `localhost`) | ✅ | Inference never leaves the machine. |
| OpenRouter, Venice, Fireworks, other ZDR routes | ❌ | Zero retention is a promise, not a proof. |
| Anthropic, OpenAI, Google, … | ❌ | Standard hosted inference. |

Pin the model so a changed default can't change the answer:

```bash
privateer -p --private --model privateer/tinfoil/gemma4-31b "…"
```

`/verify` in the TUI shows the evidence behind a model's posture.

If the model doesn't pass, every tool call comes back refused and the reply explains why.
Nothing was read, so nothing was exposed, but the task didn't happen. Treat a reply that
says private mode refused as a failure, not an answer.

## What crosses back to the caller

Private mode controls what Privateer *shows a model* and what its *tools send*. It can't
control what you **ask for**. The reply goes straight into the calling agent's context, so
the reply is the one remaining channel. Ask for something you'd be comfortable sending to
the caller's provider:

| Ask for | Not |
|---|---|
| Counts, totals, distributions, min/max, "how many rows fail validation" | "Show me the rows that fail" |
| Yes/no, pass/fail, "does any record contain a card number?" | "Which records, and what are the numbers?" |
| Schema, column names and types, row counts | Sample rows |
| A redacted or synthetic version written to a file | The original content pasted into the reply |
| "Write the full findings to `report/private.md`" | "Print the full findings" |

The last row is the general pattern: **let Privateer write detail to disk and return a
summary**. The calling agent knows the file exists and where it is. You read it; the
caller doesn't need to.

Two more things cross back, both small:

- **Your prompt.** It goes to Privateer's model as-is (it's the caller's own text). Don't
  paste sensitive data into it. Pass paths, not contents.
- **`PRIVATEER.md` context files** in the working directory are added to Privateer's
  system prompt. They reach Privateer's (private) model, not the caller, but keep them
  free of anything you wouldn't put in the prompt.

## Wiring it into another agent

The handoff works best when the calling agent can't read the files at all, not just when
it's been asked not to. Put both halves in place.

### Claude Code

Block the data on the caller's side in `.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["Read(./customers/**)"]
  }
}
```

Claude Code applies `Read` rules to its search tools too, but a shell command can still
open the files (`head`, `awk`, `python`, …). A deny list is a seatbelt, not a wall. For a wall, keep the data in a directory the calling
agent doesn't run in, and point Privateer at it (`cd` into it, or `acp.cwd`).

Then tell the agent how to delegate, in `CLAUDE.md`:

```markdown
## Sensitive data
Never open files under `customers/`. They contain personal data that must not leave
this machine except through a verified-private model.

When a task needs them, delegate to Privateer and use only its reply:

    privateer -p --private --model privateer/tinfoil/gemma4-31b "<task>"

- Name the files in the task; never paste their contents.
- Ask for aggregates, yes/no answers, or a summary. Never ask for raw rows,
  names, emails or identifiers in the reply.
- For detailed output, ask Privateer to write it to `private-out/` and report the
  path. Don't read that directory either.
- If the reply says private mode refused, stop and tell the user. Don't retry
  without --private and don't read the files yourself.
```

The same two pieces (a caller-side deny, and an instruction to delegate with `--private`)
work for Codex (`AGENTS.md`), Cursor rules, or any agent that can run a shell command.

### Your own program — ACP

An orchestrator that wants to stream the work or answer approvals itself drives
`privateer acp` over the [Agent Client Protocol](acp.md). Turn private mode on in
`~/.privateer/config.json` on the machine that holds the data:

```json
{
  "acp": {
    "private": true,
    "model": "privateer:tinfoil/gemma4-31b",
    "cwd": "/data/customers",
    "tools": ["read", "grep", "find", "ls"]
  }
}
```

(or launch it as `privateer acp --private`). What your program sees over the wire in
private mode:

| Sees | Doesn't see |
|---|---|
| Streamed reply text | Tool results (file contents are never put on the wire) |
| `tool_call` / `tool_call_update` with the tool's name and status | A failed tool's error text (it can quote the file, so private mode drops it) |
| `session/request_permission` with the tool, the command or path, and a one-line title | |

ACP sessions don't get the private-mode note in the model's instructions that `-p` runs
do, so say in your prompt what the reply may contain. Set `acp.cwd` to the data directory. It's the confinement root: reads outside it are
refused, not prompted.

The read-only `tools` ceiling above is the right default for a handoff. Add `write` and
`edit` if you want Privateer to leave detailed results on disk.

## Example tasks

```bash
# Data profiling without the data
privateer -p --private "Profile db/dump.sql: tables, row counts, and which columns look
like personal data (emails, phones, national IDs). Column names and counts only."

# Validation
privateer -p --private "Check every row of payroll.csv: does salary parse as a number and
is iban a valid IBAN? Reply with the count of failures per column. Write the failing row
numbers to private-out/payroll-failures.txt."

# Redaction for the caller's benefit
privateer -p --private "Write support/tickets-redacted.jsonl: support/tickets.jsonl with
every name, email, phone and address replaced by a stable placeholder (PERSON_1, …).
Reply with how many values you replaced, by type."

# Review a sensitive document
privateer -p --private "Read legal/nda.pdf. Does it contain a non-compete clause, and how
long is the term? One sentence each, no quotes from the text."
```

The redaction recipe is worth calling out: once Privateer has written a redacted copy, the
calling agent can work on *that* directly, with its full toolset.

## Limits

Stated plainly, so nobody finds them the hard way:

- **The reply is the caller's.** Private mode can't stop a model from putting what it read
  into its answer if you asked for it, or if a prompt injection in the data talks it into
  it. Ask for aggregates, and treat the reply as something the caller's provider will see.
- **The network check on shell commands is a heuristic.** It matches the common tools
  (`curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `git push`, `npm publish`, Python
  `requests`/`http.client`). A determined script (`python -c` with raw sockets) could
  get past it. In a `-p` run any shell command that needs approval is denied anyway, since
  nobody is there to approve it. Keep `bash` out of `acp.tools` for an ACP handoff.
- **Private means private from the provider, not from this machine.** Files Privateer
  writes, its session log under `~/.privateer/agent/sessions/`, and anything else on disk
  are as private as the machine is.
- **Verification is per process, cached for a minute.** An enclave that fails attestation
  mid-run stops tool calls within that window, not instantly.
- **`--private` doesn't choose your model.** It refuses to work with the wrong one. Pin
  `--model` (or `acp.model`) to one from the table above.

Under the hood: `src/permissions/privateMode.ts` (the check), `src/ext/permissionGate.ts`
(where it runs, ahead of every mode), `bin/headless-flags.mjs` (`--private` and the JSON
mode refusal). Tests: `tests/privateMode.test.ts`, `tests/headlessFlags.test.ts`.
