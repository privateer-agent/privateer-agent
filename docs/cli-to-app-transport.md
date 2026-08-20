# How the CLI connects to the app

How a running `privateer-agent` terminal and the Privateer client (phone / web / desktop) reach each other: the cloud relay, the loopback desktop transport, and the store-and-forward outbox for when nobody is watching.

> **Audience:** engineers touching the relay bridge, the permission gate, the desktop shell, or the app's drive session. Read [`subagents-and-remote-drive.md`](./subagents-and-remote-drive.md) and [`harbor-channels-and-app.md`](./harbor-channels-and-app.md) for what rides on top of this transport. Internal codename TreeView; public name Privateer.

---

## 0. The one-line answer

**The CLI and the app never talk directly.** Both dial *out* to the Privateer server, which acts as a dumb, tenant-scoped WebSocket relay pairing an **agent** socket to a **controller** socket. The server is treated as untrusted transport: it holds no durable state, every mutating command is account-signed, and every secret is sealed to the terminal's pinned key.

```
privateer-agent (CLI/harbor)          server (relay)                 treeview client (app/web)
  RelayClient  ──POST /relay/ticket──►  routes/relay.js
               ◄──── ticket ─────────
               ══ WS /relay?ticket ══►  server.js upgrade  ◄══ WS /relay?ticket ══  RemoteDriveContext
                    role: "agent"        relayHub (Redis)          role: "controller"
                                     relay:dn:<userId>:<termId>  ──► down to agent
                                     relay:up:<userId>:<termId>  ◄── up to controller
```

Three transports exist, in order of how often they matter:

| Transport | Wire | Used by |
|---|---|---|
| **Cloud relay** (§1–§6) | WebSocket via the server | phone / web driving a CLI or harbor |
| **Loopback IPC** (§7) | Electron IPC, same machine | the desktop app |
| **Cloud outbox** (§8) | Sealed store-and-forward | finished work with no controller attached |

---

## 1. Prerequisite — a shared account and two pinned keys

The CLI logs into the *user's* account with the device authorization grant (RFC 8628) — `src/auth/privateer.ts`. The terminal prints a short user code, the user approves it inside the already-signed-in app, and the server mints a CLI-scoped child session. The newer browser `/login` flow is the same grant with the authorize page auto-opened. Password/wallet signing happens **in the app, never in the terminal**, so this works identically for email and wallet accounts.

At link time two trust-on-first-use pins are established. They are what make an untrusted relay safe later:

| Pin | Held by | Purpose |
|---|---|---|
| Terminal **X25519** public key (`src/crypto/terminalKey.ts`) | the app (`client/services/terminalTrustService.ts`) | the app seals secrets **to** this terminal |
| Account **Ed25519** signing key (`src/crypto/accountTrust.ts`) | the terminal | the terminal verifies commands claiming to come from the account |

---

## 2. Turning it on — the agent socket

`/remote-access on` (`src/cli/chat.ts:683`) — or a harbor daemon at boot — constructs a `RelayClient` (`src/remote/relayClient.ts`) with a stable `termId` and a deliberately **non-PII** label (`terminal-a3f9`): no `user@host`, no cwd, no project name. The server and controller are supposed to learn as little as possible about the machine.

`connect()` (`src/remote/relayClient.ts:464`) does two things.

### 2.1 Mint a ticket

```
POST /relay/ticket  { role: "agent", termId, label }   →  { ticket, wsPath, expiresIn }
```

React Native's WebSocket **cannot set an `Authorization` header**, and a JWT in a WS URL leaks into logs and history. So the socket is authenticated by a single-use, 30-second random ticket minted over the authenticated REST channel instead — `server/routes/relay.js:39`, `TICKET_TTL_SECS = 30`. The JWT never enters the WS URL.

The server stashes `{ userId, familyId, relayId, role, label, takeover, machineId, machineLabel }` in Redis under that ticket, and enforces the plan's **concurrent-agent cap** here rather than at the upgrade — a WS reject can only be a bare HTTP status, whereas the ticket route returns a displayable JSON 403. Reconnects reuse the same `relayId` so a blip is never counted as a second agent; ephemeral `task-*` spawn terminals are exempt from the cap; the whole gate fails **open** on error (transport must never brick the agent).

### 2.2 Open the socket

`wss://…/relay?ticket=…` (`src/remote/relayClient.ts:495`).

The upgrade handler (`server/server.js:1379`) then:

1. rejects a disallowed `Origin` (defense in depth — a browser page can never present a valid ticket anyway; see `server/utils/relayOrigin.js`);
2. redeems the ticket with an atomic Redis **`GETDEL`** — genuinely single-use;
3. re-checks the session hasn't been revoked since the mint (`relaySessionLive`);
4. tags the socket with role / relayId / familyId / userId / machine identity and registers it with the hub.

---

## 3. Routing — `relayHub`

Fan-out lives in `server/services/relayHub.js`. Render can run more than one instance, so the two sockets may land on **different processes**; frames therefore cross over Redis pub/sub on two channels:

```
relay:dn:<userId>:<relayId>   controller → agent   (prompt | interrupt | approval_response | terminate | *_save | *_run …)
relay:up:<userId>:<relayId>   agent → controller   (event | approval_request | snapshot | context | notice | file_* …)
```

**Why the key is `<userId>:<relayId>` and not `relayId` alone (P3-1):** `relayId` is a client-chosen `termId`. Keying on it alone made tenant isolation depend on termIds being unguessable — a client bug, a short id, or a deliberately chosen id could put two accounts on the same channel. Prefixing the server-supplied `userId` makes isolation **structural, not entropy-dependent**. The `:` separator is unambiguous: `relayId`'s charset (`[A-Za-z0-9_-]`) excludes `:`, and `userId` is never client-controlled.

The hub holds **no durable state**: in-memory socket registry, ephemeral pub/sub, short-TTL presence keys. No user content is persisted — this is transport only, so CLAUDE.md §5 ("never write plaintext user content to the server") is not engaged.

Also here:

- **Presence** — 60s keys (`PRESENCE_TTL_SECS`) refreshed by the server's 25s heartbeat. `GET /relay/terminals` reads exactly these.
- **Driver lock** — `relay:driver:<route>`, a *soft* lock so two phones can't drive one terminal at once (`server/server.js:1449`). The loser gets a `driver_locked` frame immediately followed by a 4003 close, and may re-attach with `takeover: true` to demote the holder.

---

## 4. The controller side

The app lists live terminals with `GET /relay/terminals`, grouped by machine, plus a `denied` list — terminals that *tried* to connect and were refused by the plan cap. Without that, a second harbor on another machine is indistinguishable from one that was never started.

Picking one calls `drive(termId)` → `connect()` in `client/contexts/RemoteDriveContext.tsx:1158`, which mints the mirror ticket:

```
POST /relay/ticket  { role: "controller", target: termId, takeover }
```

The server verifies the caller **owns** that terminal (registry lookup, falling back to a `UserSession` lineage check for older app builds), then the client opens the same `/relay?ticket=` URL.

The drive session is hoisted to an app-global context on purpose: it used to live inside `RemoteSessionScreen`, so navigating away tore the socket down — relayed approval requests had nobody to render to and timed out into auto-deny on the CLI.

On attach the server publishes `controller_attached` down, and the CLI answers with a catch-up burst:

| Frame | Contents |
|---|---|
| `snapshot` | last 80 transcript entries, each clipped |
| `context` | model, agent version, home-collapsed cwd (`~/…`), terminal public key |
| `commands` | slash-command catalog (CLI built-ins + Pi extension commands) for composer autocomplete |
| `no_quarter` | current unattended-mode state, so the app's toggle reflects reality |

The `terminalPub` in `context` is not PII — it is a public key, and the app checks it against the **link-time pin** before sealing anything to the terminal. A malicious relay can swap it; that check is exactly why.

---

## 5. What crosses the wire

Prompts go down. Engine events stream up as `event` frames, projected and bounded by `projectEvent` (`src/remote/relayClient.ts:321`):

- **text/reasoning deltas are coalesced** on a 60ms timer (`TEXT_FLUSH_MS`) instead of one WS frame per token;
- tool input/output is normalized to text and truncated (2–4k chars);
- everything passes through `redactSecrets()` — a **safety net, not a guarantee**: bearer tokens, `sk_`/`ghp_`/`AKIA`-style keys, `*_SECRET=`-style assignments, and PEM private keys. Redaction runs on the full text *before* clipping, so a secret straddling the cut isn't missed.

**Tool execution always stays local and gated.** A remotely-driven turn relays each would-be action up as an `approval_request` and blocks on the app's Allow/Deny (`src/permissions/modeGate.ts`). Under no-quarter (unattended) mode — the flag the app raises, behind its own confirm — remote turns auto-approve outright, dangerous and destructive actions included: it is the same total bypass as the `--no-quarter` launch flag, scoped to remote turns. (An action it stopped on would be an action nobody is there to approve, so the relayed prompt would just time out closed.) The non-interactive runtimes' weaker `auto` posture (ACP, channels) is the one that still relays those — `getAutoApprove`, not `getNoQuarter`.

Files move chunked in both directions to stay under the relay's 256 KB per-frame cap:

```
app → agent   attach_begin → attach_chunk* → attach_end     (held for the next prompt)
agent → app   file_begin   → file_chunk*   → file_end       (~135 KB decoded per chunk)
```

Backstops on the agent side: 10 MB per file, 8 transfers in flight, and a running byte check in case `size` was absent or lied at begin time.

**Saving an artifact is a third chunked family, and the only one that exists because of a key the CLI doesn't have.** A Cargo row is `encryptedContent` + `encryptedMetadata`, AES-256-GCM under the account master key, and the terminal holds no master key — the device grant mints a session token and nothing else (`src/crypto/accountVerify.ts`). So `save_cargo` relays the artifact as **plaintext** and the app encrypts it, calling the same `saveCargo()` the chat's Save button and the file importer call:

```
agent → app   cargo_begin → cargo_chunk* → cargo_end        (artifact TEXT, ≤512 KB, 120k chars/chunk)
app → agent   cargo_saved                                    (keyed by the same id: cargoId, or a reason)
```

Text rather than base64 — every Cargo kind is HTML, markdown or CSV, so there is nothing binary to inflate. The ceiling is the *app's* artifact cap (`MAX_DOC_BYTES`), not the 10 MB file cap, because what arrives lands in the same store and the same preview surfaces as a model-authored artifact. Chunk payloads skip `redactSecrets()` for the same reason file bytes do: redaction inside a document is corruption.

Three things follow from the round trip and are easy to get wrong:

- **`save_cargo` needs a controller, not just a socket.** `hasController()` is checked up front, so a terminal nobody is driving fails immediately with a message naming the cause instead of waiting out the deadline.
- **The bridge supplies its own timeout** (`PRIVATEER_CARGO_TIMEOUT_MS`, 60s). Nothing else wraps a tool that awaits the app the way the gate wraps `remoteAsk`, and an app too old to understand `cargo_begin` simply never answers.
- **A mid-flight disconnect reports the outcome as UNKNOWN, not as a failure.** The app may have stored the artifact and lost the socket before replying; saying it failed is how a user ends up with two copies.

A harbor is headless, so it has no controller to ask and `save_cargo` is not registered there. An unattended run still delivers an artifact the way it always has — as a fence in its Inbox result (§8, `src/routines/resultBrief.ts`) — and that is the intended split, not a gap to close by widening this.

Beyond driving a turn, the same socket carries the management vocabulary: `extensions_*`, `skills_*`, `routines_*`, `workflows_*`, `channels_*`, `mcp_*`, `task_submit` / `task_spawn`, plus `select_request`/`select_response` and `input_request`/`input_response` for CLI-initiated prompts.

---

## 6. Why a hostile relay can't abuse it

The server is untrusted transport. Two mechanisms carry that:

**Signed control frames.** Every *mutating* command is canonical-signed by the account (`client/services/accountSign.ts`) and verified against the pinned Ed25519 key before it takes effect (`src/remote/controlAuth.ts`). The reasoning is blunt: a forged `routines_save` or `task_spawn` is a headless bypass-mode session (RCE); a forged `extensions_add` installs an npm package (RCE); a forged `skills_create` injects an auto-invoked system-prompt instruction. Verification **fails closed** (no pin, no signature, bad signature, stale ts → refuse), binds `termId` so a signature for another terminal won't match, and advances a per-terminal replay watermark.

- *non-strict* watermark for idempotent config saves — replaying the latest signed frame just re-applies the same state;
- *strict* for non-idempotent effects (`task_submit`, `task_spawn`, `workflows_run`) — each one **runs** something, so a relay replaying a valid old frame would re-run it. Strict demands a strictly-fresh `ts`, which the server cannot fabricate because it cannot sign.

**Sealed secrets.** Channel bot tokens and MCP connector env are sealed to the terminal's pinned X25519 key (`client/services/terminalSeal.ts`), so the server forwards a blob it cannot read and cannot forge. The signature covers the whole save, so it can't inject an admin or swap a token either.

The signed-args shape is duplicated on both sides (`client/services/accountSign.ts` ↔ `parseTaskSpec` / `taskControlArgs`). **Keep them in sync byte for byte** — a field added on one side silently breaks verification on the other.

---

### 6.1 Liveness and reconnect

A dead TCP socket that never fires `close` is the nastiest failure mode here — laptop sleep, instance restart, NAT idle reaping. The kernel still reports ESTABLISHED, `ws` never fires `close`, and the reconnect path (which only runs on close/error) never runs. Invisible *and* permanent.

So the client doesn't wait to be told (`src/remote/relayClient.ts:581`):

| Knob | Value | Why |
|---|---|---|
| `HEARTBEAT_MS` | 20s | our own ping; the server also pings every 25s |
| `LIVENESS_CHECK_MS` | 5s | detection granularity, cheap; bounds the post-wake dark window |
| `LIVENESS_TIMEOUT_MS` | 50s | silence beyond this ⇒ `terminate()` and take the normal reconnect path |
| `HANDSHAKE_TIMEOUT_MS` | 15s | a black-holed connect otherwise leaves `this.ws` set forever, blocking every retry |

The 50s is sized against the **server's 60s presence TTL**, not comfort: detection plus reconnect must finish inside it, or the presence key lapses and the harbor blinks out of the app while recovery is already under way.

Reconnect backoff: 3s → ×1.7 → 30s cap, ±25% jitter, reset on every successful open — a blip is invisible, but a fleet doesn't stampede a restarted relay. A 4xx refusal (the plan cap) is a *decision*, not a hiccup: it logs once in full and retries on a slow 60s cadence, kept under the server's denial-record TTL so the app's "blocked" row stays warm rather than flickering.

---

## 7. The desktop — an in-process agent over loopback IPC

The desktop app (`treeview/desktop`) skips the relay entirely. "In-process" is literal.

```
Electron main (Node 24)                       Electron renderer (Chromium)
  import "privateer-agent/src/boot.ts"          the SAME Expo web build of treeview/client
  createSession()  ← the agent lives here  ◄──IPC──►  window.privateer.relay (preload bridge)
  IpcRelay / agentSession.ts                    desktopTransport.ts → RemoteDriveContext
```

`privateer-agent` is a **dependency of the desktop shell**, not a program it launches — `desktop/package.json` carries `"privateer-agent": "file:../../privateer-agent"`, and `src/main/agentHost.ts` simply imports it. The agent runs inside Electron's main process: same PID, same heap, same Node runtime. There is:

- **no child process** — nothing spawns a `privateer` binary and pipes stdio;
- **no localhost HTTP/WS server for the agent** — the renderer reaches it over Electron IPC through a `contextIsolated` preload bridge (`window.privateer.relay`). `staticServer.mjs` *does* serve `client/dist` over `127.0.0.1`, but that's the UI bundle, not the agent channel;
- **no ticket, no WebSocket, no Redis, no driver lock.**

> **Ordering contract:** `agentHost.ts` is dynamic-imported from `main.mjs` only *after* `tsx`'s `register()` installs the TS loader, and it lists `import "privateer-agent/src/boot.ts"` **first** — boot pins `PI_CODING_AGENT_DIR` and installs the undici attestation dispatcher, and those side effects must land before any `@earendil-works/pi-*` module is evaluated. Do not reorder. (Mirrors `scripts/smoke-headless.ts`.)

### 7.1 One interface, two wires

The renderer is the *same client code* that drives a remote terminal from a phone. That works because both transports implement one interface, `RelayLike` (`src/remote/remoteBridge.ts`):

| Implementation | Wire |
|---|---|
| `RelayClient` (`src/remote/relayClient.ts`) | cloud WebSocket — phone → CLI |
| `IpcRelay` (`desktop/src/main/ipcRelay.ts`) | Electron IPC — renderer → in-process agent |

`RemoteBridge`, the permission gate, and every frame shape are reused byte for byte; only `post()` vs `ws.send()` changes. On the client side `desktopTransport.ts` translates the IPC vocabulary back into the frames `RemoteDriveContext` already speaks, and synthesizes the presence / `driver_granted` frames the UI expects (loopback needs no arbitration).

### 7.2 Two deliberate divergences

Both because loopback is trusted:

1. **No secret redaction.** `redactSecrets()` protects the cloud hop; nothing here leaves the machine.
2. **The `context` frame sends more.** `RelayClient.sendContext` home-collapses the cwd and omits the account, because an absolute path carries the OS username and that is PII on a third party's wire. `IpcRelay` sends the absolute cwd and the agent's Privateer account whole — the main process already ships both to its own window via `broadcastDesktopState`, so withholding them bought no privacy and left the banner unable to say where the agent was working or who it was signed in as. (That account is `~/.privateer/credentials.json` — the *agent's* identity, deliberately not conflated with the app's logged-in user.)

The gate moat is **not** relaxed: each window gets a full session wiring in `agentSession.ts` — gate + pi-privacy + account provider + `PRIVATEER.md` context — with the renderer attached as the controller.

### 7.3 What the desktop deliberately does not host

**Routines and channels.** Those belong to the always-on `privateer daemon` (the harbor), so background and scheduled work still needs the CLI daemon installed. The desktop is a live, interactive surface. The phone keeps driving that same machine over the cloud relay against the CLI/harbor — the desktop just adds a second, local transport to the same agent code.

---

## 8. When nobody is watching — the cloud outbox

An open socket is **not** the same as an attached controller. The server holds the agent's route open and simply drops what it forwards when no controller is present, so a driven turn that finishes after the app closes would write its answer into a socket nobody reads.

`hasController()` (`src/remote/relayClient.ts:914`) is therefore conservative — it reads true only on positive evidence (a `controller_attached`, or any frame a controller sent us) and is un-learned by `controller_detached` or a dropped socket. Presence is also inferred from traffic itself, because a terminal whose own socket reconnected mid-session never sees the original `controller_attached`.

When there's no audience, the result goes durable instead (`src/outbox/cloudOutbox.ts`):

1. fetch the account's published X25519 outbox key from the (untrusted) server;
2. verify the account's Ed25519 signature over it against the key pinned at link time;
3. seal the plaintext to it (≤ `MAX_CLOUD_PLAINTEXT`, 45 KB) and POST the blob.

The terminal holds **no account key material** — it seals *to* the account and can never open what it (or any other terminal) wrote. **Fail closed:** no pin, no signature, or a bad signature ⇒ don't seal at all, and let the caller fall back to its own durable channel (queue, file, notice). The sealed item surfaces in the app's Inbox, tagged with a machine `origin` so multi-harbor accounts can tell which box produced it.

**Envelope versions.** `v:1` is the original body; `v:2` adds `media` (attachments, inline or blob-referenced); `v:3` adds `source` — what the run was *asked* to do: the routine's own prompt, its cron/one-off trigger, the cwd it ran in, its model, and the routine id. Every version is additive and every field optional, so an older app ignores what it doesn't know and still renders the body.

`source` is what makes a delivered result **actionable**. The app's Inbox offers "Follow up" on a finished result: it builds a task prompt from the result *and* its `source` (`treeview/client/utils/followUp.ts`) and submits it — as an ordinary account-signed `task_submit`/`task_spawn` — to the harbor named by `origin.id`, which is that machine's relay termId (`routineRelayId()`). So the follow-up runs on the same box, in the same directory, knowing the standing instruction that produced what it is following up on. When that machine is offline the app asks the user which harbor to use instead rather than picking one. The result body is quoted to the model as **data**, never as instructions — an unattended run's output can contain text an attacker wrote.

---

## 9. File map

| Path | Role |
|---|---|
| `privateer-agent/src/remote/relayClient.ts` | agent-side WS client: ticket, frames, heartbeat, chunked files |
| `privateer-agent/src/remote/remoteBridge.ts` | `RelayLike` interface + callbacks wiring the relay to the gate/turn loop |
| `privateer-agent/src/remote/controlAuth.ts` | fail-closed verify for signed control frames |
| `privateer-agent/src/remote/cargoSave.ts` | the `cargo_*` wire contract + why the save is a round trip |
| `privateer-agent/src/tools/cargo.ts` | the `save_cargo` tool (validates before anything reaches the app) |
| `privateer-agent/src/outbox/cloudOutbox.ts` | sealed store-and-forward when no controller is attached |
| `privateer-agent/src/auth/privateer.ts` | device-code login, `serverBaseUrl`, `apiRequest` |
| `treeview/server/routes/relay.js` | `POST /relay/ticket`, `GET /relay/terminals`, terminate/label |
| `treeview/server/server.js:1326+` | WS upgrade, ticket redemption, driver lock, heartbeat |
| `treeview/server/services/relayHub.js` | Redis pub/sub fan-out, presence registry, driver lock |
| `treeview/client/contexts/RemoteDriveContext.tsx` | app-global drive session (controller socket, feed, approvals) |
| `treeview/client/services/accountSign.ts` | canonical signing of control frames |
| `treeview/client/services/terminalSeal.ts` | sealing secrets to the pinned terminal key |
| `treeview/client/services/desktopTransport.ts` | client-side loopback transport for Electron |
| `treeview/desktop/src/main/agentHost.ts` | the only bridge into `privateer-agent` (boot ordering contract) |
| `treeview/desktop/src/main/ipcRelay.ts` | loopback twin of `RelayClient` |
