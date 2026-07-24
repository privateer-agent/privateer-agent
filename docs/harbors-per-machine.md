# Distinguishing multiple harbors under one account

**Status:** design (not yet built) · **Date:** 2026-07-24

## Problem

A user can run the resident harbor (`privateer harbor install` / `run`) on more than
one machine or environment under the **same account** — a laptop, a home server, a
cloud VM. Today those harbors are effectively indistinguishable, and one of them is
outright unreachable from parts of the app.

Concrete failures with two harbors online (machine A + machine B):

1. **`DaemonActions` silently picks one.** `treeview/client/components/DaemonActions.tsx:38`
   does `list.find(x => x.termId.startsWith('routines-'))` — first match wins. Every
   quick action (Spawn / Routines / Channels / MCP) targets whichever harbor the relay
   listed first; the second harbor can't be reached from this surface at all. The code
   comment even assumes "there's normally one per machine."
2. **Identical labels.** Both harbors connect with the hardcoded relay label
   `"Privateer Routines"` (`src/harbor/index.ts:344`), so `LiveTerminalsList` shows two
   indistinguishable rows until the user manually renames each.
3. **Outbox results carry no origin.** The sealed envelope is
   `{ v, kind, name, status, at, content }` (`src/harbor/index.ts` `postOutbox`, decoded
   in `treeview/client/services/outboxService.ts`). A routine named `morning-brief` on
   either machine produces identical result cards — no way to tell which box ran it. By
   design the server can't add attribution (the outbox record is `{ userId, sealed,
   size, expiresAt }` — `treeview/server/models/outboxItemModel.js`).

## Key insight — the machine identity already exists

We do **not** need a new identity primitive. The machine is already a first-class
server object: the **device-login family**.

| Layer | Id | Scope | Durable | Human name |
|---|---|---|---|---|
| Relay process | `termId` (`routines-<uuid>`) | one process | Redis 60s TTL | CLI label + 7-day override |
| Terminal session | child `familyId` (+ `parentFamilyId`) | one spawned terminal | Mongo | — |
| **Machine login** | **parent `familyId`** | **one `~/.privateer` / one box** | **Mongo** | **`deviceLabel`** (e.g. `patrick@macbook`) |

`deviceLabel` defaults to `user@hostname` (`src/auth/privateer.ts` `defaultDeviceLabel`),
is sent at device login, is renamable from the app's **Linked Devices** list, and is
already returned by `GET /auth/sessions`. So surfacing it against terminals is **not a
new privacy exposure** and does **not** weaken the deliberately-non-PII *relay* stance
(`src/remote/relayClient.ts:24`): relay frames stay non-PII; the machine join happens
server-side from data the authenticated account already owns.

The whole problem is that three surfaces drop the machine dimension.

## Design — make the machine the grouping unit

### 1. Server: one join (`treeview/server/services/relayHub.js` `listTerminals`, ~line 314)

For each live terminal resolve `familyId → parentFamilyId → deviceLabel` and add two
fields to the `GET /relay/terminals` record:

```js
out.push({ termId, label, familyId, machineId, machineLabel, online: true, driven })
//                                   ^^^^^^^^^  ^^^^^^^^^^^^
//   machineId    = parent machine-login familyId (stable per box)
//   machineLabel = that family's deviceLabel ("patrick@macbook")
```

No new storage, no new privacy surface — same data `/auth/sessions` already exposes.
`machineId` is what the client groups on; `machineLabel` is what it shows.

### 2. Client: group by machine, one action strip per machine

- **`LiveTerminalsList`** — render a machine section header (`machineLabel`) with that
  box's terminals nested underneath (interactive terminals + its harbor cluster together).
- **`DaemonActions`** — remove the `find(first routines-*)`. When >1 harbor is online,
  render **one full action strip per machine**, under that machine's header (decision
  recorded 2026-07-24):

  ```
  ▸ patrick@macbook        ● online
    [Spawn] [Routines] [Channels] [MCP]

  ▸ cloud-vm-1             ● online
    [Spawn] [Routines] [Channels] [MCP]
  ```

  Each strip carries its own `familyId`/`machineId` into the navigation params so the
  drive session targets the right harbor.
- The harbor keeps the constant relay label `"Privateer Routines"`; the app composes
  `Privateer Routines · <machineLabel>`. Relay frame stays non-PII, user still sees the box.

### 3. Outbox origin — the one genuinely new field, and it is E2EE

Extend the **sealed** envelope only (`src/harbor/index.ts` `postOutbox` seal →
`treeview/client/services/outboxService.ts` `SealedEnvelope`/`OutboxResult` decode):

```js
sealJson(pub, { v: 1, kind, name, status, at, content, origin: { id, label } })
```

`origin.label` may be the real hostname — it rides **inside `sealed`**, which
`treeview/server/models/outboxItemModel.js:14` already designates as the home for
hostnames. The server still stores only `{ userId, sealed, size, expiresAt }`.
`OutboxResultsList` then shows the origin machine per card. Fully backward-compatible:
old harbors omit `origin`; old cards simply don't show it.

## Edge cases

- **Two harbors on the *same* box** (shared `~/.privateer`): `routineRelayId()` reads a
  *persisted* file (`src/routines/store.ts:28`), so both processes claim the **same
  `termId`** and fight over the relay connection. `harbor install` prevents this (single
  login service), but `harbor run` alongside the service collides. Fix separately with a
  **single-instance lock** (pidfile/flock in the global dir). Orthogonal to the
  multi-machine work but in the same area.
- **Hosted / cloud harbor** (`isHosted()`): set its `deviceLabel` to a distinct value
  (e.g. `Harbor (cloud)`) at provisioning so it reads as a separate environment class,
  not a mystery box.

## Why not a dedicated machine nickname on the agent

Redundant. `deviceLabel` is already durable, renamable from the app's device list, and
the per-box human name. Reusing it means the machine you rename in "Linked Devices" is
the same machine that groups your harbors and tags your results — one identity, not two.

## Backward compatibility

- Old server (no `machineId`/`machineLabel`) → client falls back to a flat list /
  `familyId` grouping.
- Old harbor (no `origin`) → outbox cards render without a machine tag.
- No wire-format break; all additions are optional fields.

## Rough phasing

1. **`DaemonActions` multi-harbor fix** — ✅ **DONE 2026-07-24**. Client-only. Renders one
   action strip per harbor terminal (`treeview/client/components/DaemonActions.tsx`), each
   targeting its own `termId`, instead of `find(first routines-*)`. Strips are labelled by
   `machineLabel ?? label` with a short id-suffix disambiguator on collision, so it lights
   up fully once phase 2 supplies `machineLabel`. New i18n key `code.daemon.onlineCount`
   (plural) added to all 7 locales. Typechecks clean.
2. **Server join** (`machineId`/`machineLabel`) + client grouping + composed labels —
   ✅ **DONE 2026-07-24**.
   - **Server:** resolved at ticket mint (no extra query) rather than at list time. In the
     agent branch of `POST /relay/ticket` (`treeview/server/routes/relay.js`) we already
     load the device-login session; from it `machineId = parentFamilyId ?? familyId` (the
     machine-login family — child terminals inherit `deviceLabel` and point at it via
     `parentFamilyId`, confirmed at `routes/auth.js:389,407-409`) and `machineLabel =
     deviceLabel`. Threaded through the ticket payload → WS ctx (`server.js`) →
     `relayHub.markTerminalOnline` → the ephemeral term record → `GET /relay/terminals`.
     `listTerminals`/`getTerminal` now return `machineId`/`machineLabel`; `null` for legacy
     CLIs. No new privacy surface — `deviceLabel` is already server-side and shown in
     `/auth/sessions`; relay frames stay non-PII.
   - **Client:** `LiveTerminalsList` groups by `machineId` with a machine-label section
     header **when >1 machine is present** (single machine keeps the original
     running/idle split — no regression). `DaemonActions` strips (phase 1) now light up
     with real machine names. New i18n key `settings.code.unnamedMachine` (7 locales).
   - **Latency caveat:** `machineLabel` is snapshotted at connect/ticket mint; a device
     rename while a harbor stays connected reflects on its next reconnect. Acceptable.
3. **Outbox `origin`** — ✅ **DONE 2026-07-24**. E2EE machine attribution for results.
   - **Agent:** `harbor/index.ts` `postOutbox` now seals `origin: { id, label }` into the
     envelope (cached `machineOrigin()`): `id = routineRelayId()` (stable per install),
     `label = defaultDeviceLabel()` (hostname-based). Inside `sealed`, so the server never
     sees it. Queued/re-sealed pending items pick it up on flush automatically.
   - **Client:** `outboxService.ts` decodes `env.origin` defensively (only surfaced when a
     non-empty label decrypts cleanly) into a new optional `OutboxResult.origin`;
     `OutboxResultsList` appends ` · <machine>` to each result card's meta line.
   - Backward-compatible: older CLIs omit `origin`; the card just shows no machine.
   - Verified: agent `tsc` clean; `outboxSeal` (4) + `routineDelivery` (14) tests pass.
   - Note: `origin.label` is the harbor's own `user@hostname`, not the app-renamed
     `deviceLabel` (the agent doesn't know renames), so it can differ from the phase-2
     `machineLabel` shown in the terminal list. Both clearly identify the box; unifying
     them would need the agent to learn its server-side deviceLabel (future).
4. **Single-instance lock** — ✅ **DONE 2026-07-24**. The IPC socket bind is now the
   machine's mutex. `startIpcServer` (`src/harbor/ipc.ts`) no longer unconditionally
   unlinks the existing socket (the old foot-gun that let a second harbor silently steal
   the path while the first kept running); instead it returns a `Promise<Server>` and, on
   `EADDRINUSE`, probes for a live listener — refusing with `HarborAlreadyRunningError` if
   one answers, reclaiming only a genuinely stale socket (crash, no listener). `Harbor.start()`
   is now async and binds the socket FIRST, so a rejected second instance never publishes a
   relay key, connects, or fires a tick. `runHarbor` catches the error and exits 0 (a manual
   `harbor run` beside the installed service is a clean no-op, not a crash). New test:
   "a second harbor on the same home refuses to start" (3/3 harborIpc tests pass; agent
   `tsc` clean).
