# Subagents over the relay

How Privateer lets a subagent — spawned by [`pi-subagents`](https://github.com/nicobailon/pi-subagents) — run inside the moat and surface its approvals to the phone when a terminal is being driven from the app.

> **Audience:** engineers touching the permission gate, the relay bridge, or the app's drive session. Read [`E2EE_ARCHITECTURE.md`](./) and `pi-migration-plan.md` first for the broader model. Internal codename TreeView; public name Privateer.

---

## 1. The problem

`pi-subagents` adds a `subagent` tool. When the model calls it, pi-subagents **spawns each subagent as a headless child `pi` subprocess** — foreground or background, always a subprocess (`node:child_process.spawn`), never in-process:

```
--mode json -p [--model …] [--tools …] --extension <runtime> --append-system-prompt <file> "Task: …"
```

- **stdin is ignored** (`stdio: ["ignore","pipe","pipe"]`) — the child cannot prompt over its own terminal.
- **stdout is Pi's JSONL event stream** — the parent parses `message_end` / `tool_execution_start` / `tool_result_end` to get the result.
- The child binary is chosen by `getPiSpawnCommand`: `PI_SUBAGENT_PI_BINARY` if set, else `pi` on `PATH`.

Two problems fall out of this for Privateer:

1. **The child escapes the moat.** A plain `pi` child does **not** inherit the parent's in-code permission gate / pi-privacy / account provider. Without intervention it runs vanilla — outside the RCE moat and the ZDR/TEE posture — and on a Privateer install `pi` isn't even on `PATH`, so the spawn `ENOENT`s.
2. **The child can't ask for approval.** Its gate has no stdio to prompt on, and no connection to the parent's `RemoteBridge`. A gated action (dangerous shell, out-of-scope write) would just fail closed — the app driver never sees it.

This doc describes how both are solved: **guaranteeing the moat on every child**, and **relaying a child's approvals to the app**.

---

## 2. Two ways the moat reaches a child

A subagent child is a fresh `pi` process that reads the shared `PI_CODING_AGENT_DIR`. There are two mechanisms for it to load Privateer's moat, matched to how the **parent** loads its own:

### 2a. Discovery shims — the TUI (product) path

`bin/privateer-tui` installs **re-export shims** into `$AGENT_DIR/extensions/` (`privateer-gate`, `privateer-privacy`, `privateer-account`, `pi-subagents`, …). Pi auto-discovers those in **any** process that shares the agent dir — including subagent children. So the TUI's children inherit the whole moat for free.

The TUI runs Pi's `cli.js` directly and loads everything via discovery, so it uses **no in-code factories** and never double-loads. `PI_SUBAGENT_PI_BINARY` is set to the bundled `cli.js` so children spawn the known-good `pi` and discover the shims.

### 2b. The wrapper — REPL / daemon (in-code-factory) paths

The lean REPL (`src/cli/chat.ts`), the daemon (`src/daemon`), and live task sessions load the moat as **in-code `extensionFactories`** passed to `createAgentSessionServices`. A child can't inherit those.

The obvious fix — "install the shims so children discover them" — **breaks these parents**: Pi's resource loader loads agent-dir *discovered* extensions **and** in-code factories into one list (`resource-loader.js`), so a parent that has both would **double-load** the gate (two `tool_call` hooks, two provider registrations).

Resolution: **`bin/privateer-subagent.mjs`**, set as `PI_SUBAGENT_PI_BINARY` for these parents. For each child it runs the bundled `cli.js` with:

```
--no-extensions  -e privateer-gate.ts  -e privateer-privacy.ts  -e privateer-account.ts  <original pi-subagents args…>
```

- `--no-extensions` turns **agent-dir discovery off** (so no shim double-load), but only disables *discovery* — pi-subagents' own explicit `--extension <runtime>` args still load.
- The three `-e` inject the moat **explicitly**.

Net: the child loads *exactly* pi-subagents' runtime + Privateer's gate/privacy/account — gated + private, no double-load, regardless of what the parent loaded in-code. The arg builder is a pure, unit-tested function (`tests/subagentWrapper.test.ts`).

| Parent | Loads moat via | Child gets moat via | `PI_SUBAGENT_PI_BINARY` |
|---|---|---|---|
| TUI (`privateer-tui`) | discovery shims | discovery | bundled `cli.js` |
| REPL (`chat.ts`) | in-code factories | wrapper `-e` + `--no-extensions` | `bin/privateer-subagent.mjs` |
| daemon / live tasks | in-code factories | wrapper `-e` + `--no-extensions` | `bin/privateer-subagent.mjs` |

### How a child gate behaves

`extensions/privateer-gate.ts` detects a headless child (`session_start` with `ctx.mode` ∈ `json`/`print`/`rpc`) and flips to **bypass-within-the-restricted-toolset**: pi-subagents already constrains each role's `--tools`, so normal tools auto-approve, while `decideAuto` still forces **dangerous shell / destructive / secret-exfil** actions to `"ask"`. Those "ask" outcomes are what the relay carries (§3); with no relay wired they fail closed.

---

## 3. The approval relay

When a child hits an `"ask"` action, it forwards the request to the **root parent** — the one holding the app relay — which asks the phone and sends the answer back. Because the child is a separate, stdin-less process, the transport is the filesystem.

### Components

- **`src/remote/subagentChannel.ts`** — the transport. A per-root-parent directory under the OS temp dir (`privateer-subagent-channels/<pid>-<uuid>/{requests,replies}`), advertised to descendants via the `PRIVATEER_SUBAGENT_CHANNEL` env var (inherited through pi-subagents' `{...process.env}` spawn). The child writes `requests/<id>.json` atomically and polls `replies/<id>.json`; the parent watches, answers, writes the reply, deletes the request. **Fail-closed throughout**: no parent, a timeout, an abort, or a throwing handler all resolve to deny / null.
- **`src/remote/subagentRelay.ts`** — the two adapters:
  - `makeChildGateAsk(dir)` → the child gate's `localAsk`: forwards an approval and maps the reply to `allow`/`deny` (**never `always`** — a child must not mutate the human's allowlist/mode).
  - `startParentApprovalRelay(bridge)` → a top-level session ensures the channel dir, advertises it, and watches it, relaying each ask over the existing `RemoteBridge` (`remoteAsk` / `selectRemote` / `inputRemote`). A subagent child never watches — it only forwards.

### Flow

```
child pi (gate: "ask")                 root parent (chat.ts / privateer-gate.ts)              app
  makeChildGateAsk(dir)                  startParentApprovalRelay(bridge) watcher
      │ write requests/<id>.json                                                              
      │ ───────────────────────────────▶ handler(ask)                                        
      │                                     bridge.remoteAsk(req) ─── approval_request ──────▶ existing
      │                                                                                        approval modal
      │                                     reply ◀────────────────── approval_response ──────  Allow/Deny
      │ ◀─── write replies/<id>.json ───   write reply, delete request                        
   allow/deny → gate proceeds/blocks                                                          
```

The key economy: child approvals route through the **existing** `bridge.remoteAsk` → the **existing** `approval_request` frame → the **existing** app approval UI in `RemoteSessionScreen`. **No app-side changes were needed.** Approvals raised at any nesting depth reach the one session that holds the relay (the channel dir is inherited by all descendants; only the root, non-child parent watches).

When no controller is attached, `bridge.remoteAsk` fails closed to deny — so an undriven terminal never auto-approves a subagent's gated action.

### The stopgap block

Before the relay existed, `src/ext/permissionGate.ts` shipped `REMOTE_UNSAFE_TOOLS` / `isRemoteUnsafeTool` / `blockedWhenRemote`: on a driven turn it blocks the `subagent` family outright with a notice. The TUI parent never had this block (its subagents run + relay). It remains a **stopgap in `liveTaskSession`** until that path's relay lands (§6).

---

## 4. Privacy and account on the child

The child loads `privateer-privacy` (ZDR/TEE posture + the attestation dispatcher, installed at extension-init) and `privateer-account` (the `privateer/*` provider) via discovery (TUI) or the wrapper's `-e` (REPL/daemon). It also inherits the **machine login** (`~/.privateer/credentials.json`), so Pi's on-demand OAuth (`spawnAccountCredentials`, non-interactive when machine-linked) can authenticate `privateer/*` models **per child** — distinct sessions, so no token reuse. `agent/auth.json` being empty is irrelevant: credentials come from the machine login, not persisted OAuth.

The common case needs none of this: the builtin `delegate` agent inherits the parent's model (e.g. tinfoil), so it authenticates via the inherited environment.

---

## 5. Graceful reconnect (mobile backgrounding)

Backgrounding the app suspends its relay WebSocket. The **turn keeps running on the CLI**, but the app looked dead on return, so users re-sent — colliding with the still-running turn (`sendUserMessage` → *"Agent is already processing"* → wedge). Fixed on both sides:

- **CLI** — `extensions/privateer-gate.ts` `onPrompt` has a `remoteTurnActive` busy-guard (set on send, cleared on `agent_end`): a prompt arriving mid-turn is dropped with a notice instead of throwing.
- **App** (`treeview/client/contexts/RemoteDriveContext.tsx`) — three fixes:
  - **A.** `drive()` on a same-terminal reconnect **keeps the whole feed** (was stripping to files-only, expecting a transcript snapshot the CLI never sends).
  - **B.** the `snapshot` handler only adopts into an **empty** feed — the CLI's on-attach "connected" snapshot no longer wipes a live feed.
  - **C.** an `AppState` `'active'` listener **re-opens the relay** via `connect()` (not `drive()`, so no state reset) when the app foregrounds while driving with a dropped socket. Previously `ws.onclose` had no recovery.

Result: background → foreground retains the feed, auto-reconnects, and resumes streaming — no wipe, no wedge, no re-send.

---

## 6. Known limitations / open work

- **`liveTaskSession` relay** — deferred. The daemon hosts multiple parents in one process, so the `process.env`-based channel advertisement would cross-wire. Needs per-session channel addressing (not via env). Its subagents stay blocked-when-driven via the stopgap, so there's no regression.
- **Clarify / `contact_supervisor`** — pi-subagents' `ctx.ui.custom` clarify overlay and its own supervisor channel (`<tmp>/supervisor-channels/*`, matched on `orchestratorSessionId`) are not relayed. `clarify` is **off by default** (only fires if the model passes `clarify: true`), so risk is low; if it ever bites, force `clarify:false` or shim `ctx.ui.custom`.
- **Cold-attach history** — §5's fix B retains a *warm* feed, but a *cold* attach (killed app, second device) starts blank because the CLI sends an empty on-attach snapshot. A real first-attach transcript snapshot would close this.
- **Live verification pending** — the parent→app relay is verified live; the full child→parent→app hop and a `privateer/*`-pinned subagent's headless inference still need a clean driven run to confirm.

---

## 7. File reference

| File | Role |
|---|---|
| `src/remote/subagentChannel.ts` | filesystem request/reply IPC (fail-closed) |
| `src/remote/subagentRelay.ts` | child gate-ask forwarder + parent watcher adapters |
| `bin/privateer-subagent.mjs` | moat-injecting child-spawn wrapper (`-e` + `--no-extensions`) |
| `extensions/privateer-gate.ts` | the moat: gate + `RemoteBridge`; child-forward + parent watcher wiring; headless bypass; busy-guard |
| `src/ext/permissionGate.ts` | `decideToolCall`, `REMOTE_UNSAFE_TOOLS` stopgap block |
| `src/cli/chat.ts` | REPL: sets `PI_SUBAGENT_PI_BINARY`, starts the parent relay |
| `bin/privateer-daemon.mjs` | daemon: sets `PI_SUBAGENT_PI_BINARY` |
| `bin/privateer-tui` | TUI: installs discovery shims, sets `PI_SUBAGENT_PI_BINARY` |
| `treeview/client/contexts/RemoteDriveContext.tsx` | app drive session: reconnect + feed retention |
| `tests/subagentChannel.test.ts`, `subagentRelay.test.ts`, `subagentWrapper.test.ts` | unit coverage |

## 8. Verifying end-to-end

1. Launch `bin/privateer-tui` (installs shims, sets the child binary), `/remote-access on`, and drive from the app.
2. Optional ground-truth watcher on the host:
   ```bash
   while :; do find "${TMPDIR:-/tmp}/privateer-subagent-channels" -type f 2>/dev/null; sleep 0.4; done
   ```
3. From the app, force a delegated **gated** action:
   > Use the `subagent` tool (action: run) to spawn a subagent whose entire task is to run `rm -rf /tmp/privateer-subagent-test`. Do not run it yourself.
4. Expect: the `subagent` spawn approval (parent gate), then — when the child hits the dangerous command — a **`requests/<id>.json`** in the watcher and a second `Run command` approval in the app. Approve/deny flows back to the child.
