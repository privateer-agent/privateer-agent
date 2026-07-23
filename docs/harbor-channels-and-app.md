# Privateer Agent — Harbor, Channels, Terminal Sessions, and App Integration

> Internal codename **TreeView** · public name **Privateer**. This document explains
> how the always-on **harbor**, the **channels** bridge, and **terminal sessions**
> fit together, how the **Privateer app** drives them, and — most importantly — where
> the privacy/security boundaries are and what they do and do not guarantee.
>
> Audience: engineers working on `privateer-agent` and the `treeview` client/server.
> It describes the system as built, including the honest limits of the current
> app→terminal sealing (see [Security model](#security-model)).

---

## 1. The pieces at a glance

```
   ┌──────────────────────────────┐         relay (WebSocket via server)        ┌─────────────────────────┐
   │  Privateer app (treeview)    │  ◄──────────────  ciphertext  ─────────────►│  privateer-agent         │
   │  · RemoteDriveContext        │                                             │  on the user's machine   │
   │  · Channels/Routines/Skills/ │        REST (auth, device-code, sessions)   │                          │
   │    Extensions screens        │  ◄──────────────────────────────────────────│  · TUI / REPL session    │
   └──────────────────────────────┘                                             │  · harbor (always-on)    │
                                                                                │  · channels harbor       │
   server (treeview/server): auth, JWT sessions, relay hub, outbox store.       └─────────────────────────┘
   Treated as UNTRUSTED for user content (stores/forwards ciphertext only).
```

Three long-lived agent roles, each a separate process/session:

| Role | Process | Purpose | Relay? |
|------|---------|---------|--------|
| **Interactive terminal** | `privateer` TUI (`src/main.ts` → `cli/chat.ts`) | The coding agent a human types at | Optional, per session, when the user enables remote-access |
| **Harbor** | `src/harbor/index.ts` (`privateer harbor`) | Runs **scheduled routines**; hosts the app-facing **management** surface (routines + channels config) | Always, when the account is signed in |
| **Channels harbor** | `src/channels/run.ts` (`npm run channels`) | Bridges **Telegram/Slack/Discord/WhatsApp** chats to agent turns | No relay — reads config from disk |

The **relay** is a server-forwarded WebSocket that lets the app drive a terminal.
The **REST** endpoints handle account login (device-code), session listing, and the
cloud outbox. All of it goes through the Privateer server, which is untrusted for
content.

---

## 2. The harbor

`src/harbor/index.ts` is the resident process behind the **"Privateer Routines"**
terminal. It does two jobs:

### 2.1 Scheduled routines
- Routines (saved unattended agent tasks) live in `~/.privateer/routines/` (see
  `src/routines/store.ts`). Each has a trigger (`cron` or one-off `at`), a prompt, a
  cwd, a model, a tool set, and delivery channels.
- The harbor ticks once a minute (`TICK_MS`), runs due routines headlessly through a
  Pi session with an **auto-approve gate restricted to a safe tool set** (`SAFE_TOOLS`
  — read/grep/find/ls), and delivers the result via `file` / `notice` / `relay` /
  `cloud` / `email` / `webhook:<name>`.
- Results destined for the app when it's offline go to the **cloud outbox**
  (sealed; see §6.3).

### 2.2 App-facing management (over its always-on relay)
Since the routines memory landed, the harbor **connects its relay whenever the
account is signed in** (`syncRelay`), not only when a routine wants `relay` delivery.
That makes the "Privateer Routines" terminal a general, always-reachable **management
terminal** — the app can create the very first routine, or configure channels, before
either harbor has otherwise done anything.

On that one relay the harbor answers two manager surfaces:
- **Routines** — `routines_*` frames → `src/remote/routinesControl.ts` (list / save /
  delete / pause / run over `routines.json`).
- **Channels** — `channels_*` frames → `src/remote/channelsControl.ts` (list / save /
  remove over the `channels` block of `config.json`).

Both are **UI-agnostic controls**: they validate + persist and never import the relay
or React. The harbor owns the frame plumbing (`onControllerAttached` primes both
lists; each mutation re-pushes the list with a one-line result).

---

## 3. Channels

A **channel** turns an allow-listed chat into a prompt: a user's message becomes an
agent turn, the reply goes back to the chat. It's the inbound mirror of the relay
(the relay lets the *app* drive the terminal; a channel lets a *chat* drive it).

### 3.1 The channels harbor (`src/channels/run.ts`)
- A **separate process** from the relay harbor. It reads the `channels` block of
  `~/.privateer/config.json` at startup and starts one `MessagingBridge` per
  configured platform (`telegram`/`slack`/`discord`/`whatsapp`). Each platform is just
  a dumb `ChannelAdapter` transport; the shared bridge does allow-listing, per-chat
  serialization, redaction, and chunking.
- **Config + restart only, by design.** There is deliberately no in-chat toggle for
  roles or posture — a restart is the fail-safe reset. This is a load-bearing security
  choice (see §7).

### 3.2 Authorization model (per channel)
- **Admins** — governed by the channel `posture`; the only users whose in-chat yes/no
  resolves an approval prompt.
- **Members** — may chat, but every turn runs **read-only** and they cannot approve.
- **Posture** (admins only; members are always read-only):
  - `readonly` — deny every write/edit/bash/fetch,
  - `approve` — each risky action prompts an admin in-chat (default),
  - `auto` — non-dangerous actions run unattended; dangerous shell + destructive
    actions still prompt.
- `tools` is the hard **tool ceiling** an admin can reach (default: read-only).

Bot tokens live in `config.json` **in plaintext on the machine** — protect that file's
permissions. (The same posture applies to the terminal identity key in §6.1.)

### 3.3 Heartbeat (`src/channels/status.ts`)
Because the channels harbor and the management harbor are different processes, the
channels harbor writes a small heartbeat (`~/.privateer/channels-status.json`, every
30 s) listing the platforms it's actively serving. `channelsControl` reads it to show
the app a **live / configured-but-offline** badge — best-effort presence, never a
dependency.

---

## 4. Terminal sessions & linking

### 4.1 Device-code login (RFC 8628)
The terminal never sees a password or wallet key. Instead:
1. Terminal → `POST /auth/device/code` → short `user_code` + secret `device_code`.
   The terminal also sends its **identity public key** (`terminalPub`, see §6.1).
2. The human enters `user_code` in the already-logged-in app
   (`LinkTerminalScreen` → `POST /auth/device/approve`), binding the pending login to
   their account. The app **pins** the returned `terminalPub` (see §6.2).
3. Terminal polls `POST /auth/device/token`, receives a CLI-scoped JWT session.

This works identically for email and wallet accounts — all identity proof happens in
the app.

### 4.2 Parent + child sessions
The device-code session is the **machine login** (a `familyId`). Each running terminal
process spawns its own **child session** from the parent refresh token
(`spawnChildSession`), held in memory only, so many terminals on one machine rotate
tokens independently without tripping refresh-reuse detection. Children surface in
`GET /auth/sessions` (nested under their machine) and are individually revocable.

### 4.3 The relay
When a terminal enables remote-access it opens a relay WebSocket keyed by a `termId`
(the harbor uses a stable `routines-…` id; interactive terminals use a per-terminal
id). The server's relay hub routes frames between the app (driver) and the terminal,
enforcing a soft single-driver lock. The relay carries **EngineEvents** up (streamed
text, tool calls) and **prompts/approvals/commands** down.

---

## 5. How the app integrates

### 5.1 The drive session (`client/contexts/RemoteDriveContext.tsx`)
One global context owns the relay connection and exposes it to every screen: `feed`,
`status`, `working`, approvals, `noQuarter`, the advertised `commands`, plus the
manager surfaces. `drive(termId)` focuses it on a terminal; `submit`, `interrupt`,
`answerApproval`, `terminate` act on it.

### 5.2 Relay frame vocabulary
The app and terminal speak a small typed frame set:

| Direction | Frames |
|-----------|--------|
| app → terminal | `prompt`, `interrupt`, `command`, `approval_response`, `select_response`, `input_response`, `no_quarter`, attachments, `extensions_*`, `skills_*`, `routines_*`, `channels_*` |
| terminal → app | `event` (text/tool/finish), `context` (model/version/**terminalPub**), `notice`, `commands`, `select_request`, `input_request`, `extensions`, `skills`, `routines`, `channels`, file transfer |

Each app-manageable feature has the same three-part shape: a `*Control.ts` on the
agent, a `*_*` frame family, and a screen in the app:

| Surface | Agent | Screen |
|---------|-------|--------|
| Routines | `routinesControl.ts` (harbor relay) | `RoutinesScreen` |
| Channels | `channelsControl.ts` (harbor relay) | `ChannelsScreen` |
| Skills | `skillsControl.ts` (per interactive terminal) | `SkillsScreen` |
| Extensions | `extensionsControl.ts` (per interactive terminal) | `ExtensionsScreen` |
| Live drive | `RemoteBridge` | `RemoteSessionScreen` |

The **Channels** and **Routines** actions live on the "Privateer Routines" terminal
card in `LiveTerminalsList`; Skills/Extensions/Drive live on interactive terminals.

### 5.3 The channels flow, end to end
1. App opens `ChannelsScreen` → `channels_list` → harbor replies with a `channels`
   frame (all four platforms; **never a token value**, only `secretsSet` names +
   counts + posture + `running`).
2. User edits roles/posture/tools/model and (if the terminal is *sealable*, §6) bot
   credentials.
3. `saveChannel` sends `channels_save` with a plaintext `draft` (non-secret fields)
   and, when secrets are present, a **sealed** `sealedSecrets` blob.
4. Harbor validates, opens the sealed blob, verifies the embedded `termId`, merges,
   writes `config.json`, and re-pushes the list. **Changes reach live bridges on the
   channels harbor's next restart.**

---

## 6. Privacy & security — the core

Privacy is the product's reason to exist, so the architecture starts from **"the
server is untrusted for user content."** Everything below follows from that.

### 6.1 Terminal identity key (`src/crypto/terminalKey.ts`)
Each machine mints a persistent **X25519 keypair** at `~/.privateer/terminal-key.json`
(created `0600`). The public half is the terminal's identity; the private half never
leaves the machine and is used only to open secrets sealed to it (§6.4).

### 6.2 TOFU pin (trust-on-first-use)
At link time the terminal's `terminalPub` is bound into the device-code grant and the
app **pins** it on approval (`client/services/terminalTrustService.ts`, stored in
EncryptedStorage, cleared on logout). Later, when a terminal advertises its `terminalPub`
over the relay `context` frame, the app trusts it **only if it matches a pin**. A
server that swaps the key *after* linking is rejected.

- **Guarantee:** a server that turns malicious *after* a terminal is linked cannot get
  the app to seal to a key it controls.
- **Accepted limit (F1):** the only truly out-of-band element is the human-carried
  `user_code`; it authenticates *intent to link*, not the key. A server malicious *at
  the single link moment* can present its own key. The future hardening is
  **fingerprint verification** (terminal shows a fingerprint, app shows the same, user
  compares) — SSH/Signal style.

### 6.3 Content E2EE (existing)
All chat content, AI responses, images, and titles are encrypted client-side before
leaving the device (`client/services/cryptoService.ts`); the server stores ciphertext
only. The **cloud outbox** is the terminal→account mirror: a terminal seals unattended
results to the account's public key (`crypto/outboxSeal.ts`) — terminals are
**write-only** and hold no account key, so a stolen terminal can post but never read.

Because the terminal holds no master key, it can't derive the outbox public key itself
— it fetches it from the (untrusted) server. To stop a malicious server from
**substituting a recipient key it controls** (which would let it read every sealed
result), the app **signs the published outbox key** with the account signing key, and
the terminal **verifies that signature** against the key it pinned at link
(`accountVerify.ts` `verifyOutboxKey`, symmetric with the channel-config path) before
sealing. Verification is fail-closed: no pin, a missing signature, or a bad signature
makes the terminal refuse to seal, and the `cloud` channel falls back to a local
`notice` (the result is deferred, never leaked). Residual: the F1 link-moment window.

### 6.4 App→terminal channel config: confidentiality + authenticity
Channel config is set from the app with **two** independent protections, so the server
neither reads the token nor can forge the config:

**Confidentiality (bot tokens are sealed).** `client/services/terminalSeal.ts` seals
`{termId, secrets}` to the terminal's pinned pubkey (X25519 → HKDF-SHA256 →
AES-256-GCM, domain label `privateer-channel-seal-v1`, distinct from the outbox label);
the harbor opens it with `src/crypto/terminalUnseal.ts`. Plaintext tokens never travel;
the server forwards ciphertext only.

**Authenticity (every save is signed — Phase 4).** A sealed box gives confidentiality
but *not* sender authenticity: the terminal's public key is public (the server forwards
it), so anyone who knows it could otherwise *create* a valid sealed blob, and the
non-secret fields (`admins`/`posture`/`tools`) would travel in plaintext. To close that
(the review's F7/F8): the app **signs the whole envelope** — `{termId, ts, draft,
sealedSecrets}` — with an **Ed25519 key derived from the account master key**
(`client/services/accountSign.ts`), and the harbor **verifies** it
(`src/crypto/accountVerify.ts`) against the account signing public key it **pinned at
link time** (`src/crypto/accountTrust.ts`, delivered through the human-approved
device-code grant, symmetric to §6.2). Only the master-key holder can sign, so a
hostile relay can neither forge a token nor inject an admin. The signature also binds
`termId` (defeats misrouting) and `ts` (the harbor rejects any `ts` at or below the
last it applied — no replay/rollback). Verification is **fail-closed**: no pin, a
missing signature, a bad signature, or a stale `ts` all refuse the entire save.

- **Guarantees:** the server cannot **read** a user's bot token, and cannot **forge or
  tamper with** channel config (tokens *or* admin list) — a change the account didn't
  sign is rejected.

**Every mutating control frame is signed, not just `channels_save` (H2).** The same
account-signature scheme covers **all** app→terminal mutations sent over the untrusted
relay — `routines_save`/`delete`/`set_enabled`/`run`, `extensions_add`/`remove`,
`skills_create`/`delete`/`set_enabled`, and `channels_remove`. Each is signed by the
app (`client/services/accountSign.ts` `signControl`, domain `privateer-control-v1`,
binding `termId` + `ts`) and verified terminal-side (`crypto/accountVerify.ts`
`verifyControl` via `remote/controlAuth.ts`, fail-closed) before it takes effect. This
matters because these frames have severe *local* side effects that bypass the agent's
permission gate: a forged `routines_save`+`run` runs a headless **bypass-mode** session
(→ RCE), a forged `extensions_add` installs an npm package (→ RCE), and a forged
`skills_create` injects an auto-invoked system-prompt skill. Without signing, the
untrusted server could forge any of them; with it, a server that turns malicious after
link cannot. The replay watermark is **per-terminal** (`crypto/accountTrust.ts`
`control-sig.json`), so the always-on harbor and interactive terminals don't
cross-reject each other's independent `ts` streams.

### 6.5 Honest limits (what still trusts the server, and where)
- **Link-moment TOFU (F1), both directions.** Both pins — the app's pin of the
  terminal key (§6.2) and the terminal's pin of the account signing key (§6.4) — are
  established through the device-code link, which the server mediates. A server
  malicious *at the single moment of linking* could substitute a key. A server that
  turns malicious *after* linking cannot (the pins reject a swap). Fingerprint
  verification is the future hardening that would close even the link-moment window.
- **Machine-local trust roots.** `config.json`, `terminal-key.json`, and
  `account-trust.json` are plaintext on the machine; an attacker with local filesystem
  access defeats these protections. Protect their permissions (all written `0600`).

> **Accurate claim:** channel bot tokens are confidential from the server, and channel
> config is authenticated to the account — the server can neither read the token nor
> forge/alter the config. The residual trust is the one link-moment (F1) and local
> filesystem access.

### 6.6 Defense-in-depth already in place
- Secrets are entered in the app **only** when the terminal is *sealable* (pin match),
  and `saveChannel` re-checks trust before sealing — fail-closed with a user message
  otherwise; nothing sensitive is sent to an unverified terminal.
- No API key, token, or account secret is ever stored on the client or sent to the
  server in plaintext.
- Unattended surfaces (routines, channel member turns) default to a **read-only** tool
  set; risky actions fail-closed when nobody can approve.
- `config.json` and `terminal-key.json` are the machine's plaintext trust roots —
  protect their file permissions.

---

## 7. Design principles worth preserving

1. **Server is untrusted for content.** Every new data path must assume the server
   reads what it forwards; encrypt/seal before it leaves the device.
2. **Fail-closed.** No controller, a disconnect, an untrusted terminal, or an
   unverifiable seal all resolve to *deny / don't send*, never *allow / send in the
   clear*.
3. **Restart is the fail-safe** for the channels harbor — roles/posture reset to
   config on restart; there is deliberately no live in-chat privilege toggle.
4. **One control, one frame family, one screen** per app-manageable feature — mirror
   the routines/channels/skills/extensions pattern rather than inventing new plumbing.
5. **Authorization changes deserve the strongest path.** Who can drive the agent
   (admins), how freely (posture), and how far (tools) are security decisions; prefer
   authenticated/terminal-confirmed paths for them over server-forwarded plaintext
   (see §6.5).

---

## 8. Workflows (proposed) — routed multi-agent routines

> **Status: agent/harbor side built & tested; app side planned.** This section
> specifies *declarative multi-agent workflows* on the harbor — the schema, runner,
> store, control, and relay wiring now exist (`src/workflows/*`,
> `src/remote/workflowsControl.ts`, the `workflows_*` frames, `tests/workflows.test.ts`).
> It pins down the shape and — above all — the security seam, because a workflow file is
> an **executable control artifact**, not passive data. The **mobile UX + sharing plan**
> lives in [`workflows-mobile-plan.md`](./workflows-mobile-plan.md).

### 8.1 What it adds, and why it isn't just a bigger routine
A routine (§2.1) is **one prompt** on a trigger. A workflow is a **routed graph of
steps** — the same unattended, harbor-run, safe-tool-gated execution model, but with
branching, fan-out, human gates, and sub-workflow composition between steps. It is the
thing the [[spawn-agent-from-app]] and [[subagents-blocked-when-driven]] work gestures
at, made *declarative* and *deterministic* rather than agent-improvised.

The file format deliberately adopts the vocabulary of **Microsoft Conductor**
(`microsoft/conductor`, MIT) rather than inventing one — a flat list of typed steps
plus a per-step `routes:` graph. We reuse its taxonomy; we do **not** reuse its trust
model (Conductor is a local CLI with no untrusted server; we have §6).

### 8.2 The step taxonomy, mapped onto existing primitives
| Conductor `type:` | Privateer execution | Notes |
|---|---|---|
| `agent` | a headless Pi session under the **`SAFE_TOOLS` auto-approve gate** (as routines run today) | `tools:` is the ceiling, same semantics as `Routine.tools` |
| `script` | a shell command | ⚠️ **bypasses the agent permission gate — RCE surface**, see §8.4 |
| `human_gate` | pause → surface `options:` to the app as an **approval over the harbor relay** | native fit for the existing `approval_response` frame + app approval UI |
| `set` / `wait` | pure context transform / sleep | no LLM, no tools, harmless |
| `workflow` | sub-workflow (local path only — **no registry/GitHub refs**, §8.4) | composition |
| `terminate` | end `success|failed` | the fail-closed exit (§7.2) |

`for_each` / `parallel` fan-out map onto spawning N gated Pi sessions with a
`max_concurrent` cap (mirror the harbor's existing one-at-a-time discipline; don't let
a workflow outrun it).

### 8.3 Storage and the control surface (mirror routines exactly)
Follow principle §7.4 — **one control, one frame family, one screen**:
- **Store:** workflow files live one-per-file in `~/.privateer/workflows/`, alongside
  `routines/`. A `workflows/store.ts` + Zod `schema.ts` (the §8.2 subset of Conductor's
  grammar — we validate strictly and reject unknown `type:`s) is the sibling of
  `routines/store.ts`. **Canonical on-disk format is `w-<id>.json`** (what the app
  authors); hand-edited `*.yaml` authoring is a follow-up that adds a YAML parser and an
  async loader accepting both — deliberately out of the first skeleton so it stays
  dependency-free.
- **Trigger:** a workflow is invoked exactly like a routine — a `cron`/`at` entry in
  `routines.json` may name a `workflow:` instead of a `prompt:`, so the resident
  scheduler (§2.1) is the single entry point. No second scheduler.
- **Control:** `src/remote/workflowsControl.ts` (UI-agnostic, no React/relay import,
  like `routinesControl.ts`): `list / save / remove / setEnabled / run`.
- **Frames:** a `workflows_*` family, `workflowsControl` on the **harbor relay**.
- **Screen:** a `WorkflowsScreen`, on the "Privateer Routines" terminal card next to
  Routines/Channels.

### 8.4 Security — the load-bearing part
A workflow file can run shell (`script`) and can run `agent` steps with write tools.
Both **bypass the interactive permission gate** the same way a `routines_save`+`run`
does — this is precisely the RCE surface §6.4 (H2) already identified. So the workflow
path inherits H2's rules, no exceptions:

1. **Every mutating `workflows_*` frame is account-signed and fail-closed.** `save`,
   `remove`, `setEnabled` route through `authorizeControl` (`remote/controlAuth.ts`)
   in **non-strict** mode (idempotent config writes). `run` — which *executes* — routes
   through **`strict` mode** (`ts` must be strictly fresh), exactly as `task_spawn`
   does, so a hostile relay can't replay a run frame to re-fire the graph. A server that
   turns malicious after link can neither install a workflow nor trigger one.

2. **The workflow body is inside the signed envelope.** The signature binds the whole
   file (or its content hash), not just the frame verb — otherwise the server could
   sign-wrap an app's innocuous `save` around a body it swapped. The pinned account key
   (§6.4) is the only signer.

3. **`script` and unattended write-tools are gated by posture, not free.** In the
   unattended path (no human driving), `script` steps and dangerous tools **fail-closed
   to a `human_gate`** — the run pauses and seals a "needs approval" notice to the cloud
   outbox (§6.3) rather than proceeding. `human_gate` resolves *only* through the
   account-authenticated approval path, never an unsigned relay frame.

4. **Sub-workflows are local-path only.** Conductor's `name@team#version` registry and
   `name@owner/repo#ref` GitHub refs are **rejected by the schema** — a remote ref is an
   unsigned code-fetch, i.e. an RCE the server could redirect. Composition stays within
   the user's own signed, on-disk `workflows/`.

5. **Content that transits the relay for app visibility is E2EE.** A workflow's
   intermediate step outputs shown live in `WorkflowsScreen` ride the same
   content-encryption as every other feed frame (§6.3); results delivered while the app
   is offline go to the sealed cloud outbox, never plaintext.

- **Guarantee (inherited from H2):** the untrusted server can neither **install** a
  workflow, **trigger** one, nor **tamper** with a step's tools/script — every such
  change is an account-signed, replay-guarded, fail-closed control frame. Residual trust
  is the same as everything else: the F1 link moment and local filesystem access (§6.5).

### 8.5 What we deliberately do *not* take from Conductor
- No `budget_usd`-as-trust-boundary — budget is a resource cap, not a security control;
  the gate is still the tool posture.
- No remote workflow registry (§8.4 #4).
- No live in-graph privilege change — restart/re-sign is the fail-safe, per §7.3.
