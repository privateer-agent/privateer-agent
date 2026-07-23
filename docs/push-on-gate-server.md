# Push-on-Gate — server-sent push (SPEC, not built)

> Companion to [`workflows-mobile-plan.md`](./workflows-mobile-plan.md) §2 (the gate is the
> hero) and the client-side local-notification wiring already shipped
> (`treeview/client/services/notificationService.ts` + the `pendingSelect` effect in
> `RemoteDriveContext.tsx`).
>
> **Status: DESIGN ONLY — nothing here is built.** Priority: low / later. This doc is the
> pick-up-later plan for the one thing local notifications *can't* do: alert a person whose
> app is fully closed.

---

## 1. Problem

A workflow `human_gate` opens on the harbor and holds for `GATE_TIMEOUT_MS` (5 min) before it
fail-closes to the cloud outbox. The person who must approve is usually not looking at the app —
that's the whole "automation in my pocket" premise.

**What's already handled (client-only, shipped):** a *local* notification fires when the gate
arrives *while the app is backgrounded but still alive* (JS running, relay socket up). See the
`notifyGate` wiring.

**The gap this spec fills:** if the app is **fully killed / swapped out**, its relay socket is
gone, so it never receives the gate frame and never fires a local notification. Only a
**server-sent push** (APNs / FCM), delivered by the OS independent of the app process, can reach
that person. That needs three things that don't exist yet: (a) device push-token registration,
(b) a server push sender, (c) a trigger that fires when the harbor opens a gate.

## 2. Non-goals

- Not building interactive **Approve/Hold from the lock screen without opening the app**. That
  needs a background task to re-establish the E2EE relay and answer — fragile; a later phase.
  Here, tapping the push **opens the app to the gate**.
- Not replacing the shipped local notification — this augments it for the killed-app case.
- Not a general notification framework (marketing, chat mentions, etc.). Gate-only.

## 3. The hard constraint: content-free push (E2EE)

The relay (`treeview/server/server.js` + `services/relayHub.js`, Redis pub/sub) is **pure
ciphertext transport** — it authenticates the socket and routes opaque frames; it never reads
frame content. The gate's prompt is user content and is E2EE. Therefore:

> **The push payload MUST carry no user content.** No workflow name, no gate prompt, no step
> text. Body is a fixed, localized string ("A workflow needs your approval"). Anything else
> leaks plaintext to Apple/Google and the push relay — a direct violation of the E2EE hard
> rules in `treeview/CLAUDE.md` §5.

The push is a **content-free wake signal**. After the app opens and attaches, it receives the
real (E2EE) gate over the relay and decrypts it locally — exactly as it does today.

Routing metadata (which device family / terminal to attach to) is *connection* metadata the
relay already brokers, not user content, so a coarse `familyId`/`termId` in the payload is
acceptable. Keep it minimal.

## 4. Architecture

```
   harbor (privateer-agent)                 relay server (treeview/server)             device
  ┌────────────────────────┐               ┌───────────────────────────────┐        ┌────────┐
  │ askGate() opens a gate  │  push_wake    │ relay WS (pure transport)     │        │  app   │
  │ pendingGates.set(id,…)  │──────────────▶│  ├ is an app socket live for  │        │(killed)│
  │  + sendPushWake(fam)    │ (content-free │  │   this account/family?      │        └────────┘
  │                         │  control frame│  │     yes → do nothing        │             ▲
  │                         │  over relay)  │  │     no  → pushService.send  │  APNs/FCM   │
  │                         │               │  │            (content-free)   │─────────────┘
  └────────────────────────┘               │  └ pushDeviceModel: tokens/acct │   OS shows push
                                            └───────────────────────────────┘
       app earlier registered its Expo push token → POST /api/push/register (authenticated)
```

Trigger flow:

1. **Harbor opens a gate** (`askGate`). In addition to sending the E2EE `select_request` to any
   attached controller, it emits a **content-free** `push_wake` control frame over its existing
   relay connection.
2. **Relay checks presence.** `relayHub` knows whether the account/device-family has a live app
   socket. If an app is connected, the in-app + local-notification path already covers it →
   **no push** (avoid double-alerting). If none is connected (or after a short grace window),
   proceed.
3. **Server sends push.** Look up the account's registered device tokens (`pushDeviceModel`),
   send a content-free push via `pushService` (Expo push API / `expo-server-sdk`).
4. **User taps → app opens → attaches** to the named family/terminal. The harbor **re-emits any
   open `pendingGates`** on attach (see §7 — a required change; `onAttachment` is a no-op today),
   so the reconnected app renders the gate and the person answers over the live E2EE relay.

## 5. Component changes

### 5.1 Client (`treeview/client`)
- **Token registration** — extend `services/notificationService.ts`:
  `registerPushToken()` → `getExpoPushTokenAsync()` (needs the EAS `projectId`), then
  `POST /api/push/register { token, platform }` (authenticated). Call it after permission is
  granted in `setupGateNotifications()`, and on Expo's token-change listener. De-register on
  logout (`POST /api/push/unregister`).
- **Tap handling** — add a notification-response listener (`addNotificationResponseReceivedListener`)
  that reads the payload's `familyId`/`termId` and routes the drive session there
  (`RemoteDriveContext.drive(familyId)`), landing on `WorkflowRunScreen`/the gate. On a cold
  launch, read `getLastNotificationResponseAsync()` and do the same after auth restores.
- **No new user content leaves the device** — only the opaque push token (a device identifier,
  not user content) and coarse routing ids.

### 5.2 Server (`treeview/server`)
- **`models/pushDeviceModel.js`** (new) — `{ userId, token, platform: 'ios'|'android', family?,
  createdAt, lastSeenAt, disabledAt? }`. Unique on `token`. Keyed by `user.id` (works for
  wallet users too — never key on email, per CLAUDE.md §1).
- **`routes/push.js`** (new, behind `authenticate`) — `POST /api/push/register`,
  `POST /api/push/unregister`. Rate-limited (reuse `middleware/rateLimiter.js`).
- **`services/pushService.js`** (new) — wraps `expo-server-sdk`: `sendGateWake(userId, { family })`
  → loads active tokens, sends the fixed content-free payload, prunes tokens the receipt marks
  `DeviceNotRegistered`.
- **Server-only storage exception** — push tokens live server-side keyed by `userId` even for
  `local` storage-backend accounts, the same explicit carve-out as billing (CLAUDE.md §2). They
  are device identifiers, not user content. Document this in the model header.

### 5.3 Relay (`treeview/server/server.js` + `services/relayHub.js` + `routes/relay.js`)
- Handle a new **`push_wake`** control frame from a harbor socket: authenticate it belongs to the
  account (same session/ticket auth the relay already enforces), then ask `relayHub` whether an
  **app** socket is live for that account/family.
- **Offline gate:** if an app socket is present → drop (covered in-app). If absent → call
  `pushService.sendGateWake`. Optionally a short debounce/grace (e.g. 3–5 s) to let a
  briefly-backgrounded app reconnect before paying for a push.
- **Abuse control:** only a harbor socket authenticated for the account may trigger a wake for
  that account; rate-limit per account (a gate can't fire pushes faster than gates open).

### 5.4 Harbor / agent (`privateer-agent`)
- **`src/remote/relayClient.ts`** — add `sendPushWake(family?)` that emits the content-free
  `push_wake` frame (sibling of `sendNotice`). No content, ever.
- **`src/harbor/index.ts`** — in `askGate` (where `pendingGates.set` happens), also call
  `relay.sendPushWake(...)`. And implement **`onAttachment`** (currently `() => {}`) to re-emit
  every open `pendingGates` entry as a fresh `select_request`, so a pushed-then-opened app that
  attaches after the gate opened actually sees it. **This reconnect re-emit is required for the
  feature to work end-to-end** and is independently useful (fixes silent gate loss on any
  reconnect).

## 6. Provider choice

- **Recommended P1: Expo push** (`expo-server-sdk` + `getExpoPushTokenAsync`) — minimal work,
  already aligned with `expo-notifications`. Trade-off: routes through Expo's push service (a
  third party). Acceptable *because the payload is content-free*; Expo sees only "this device has
  a pending approval," not what.
- **P3 hardening (optional): direct APNs/FCM** to drop the Expo intermediary — more infra
  (certs/keys, token management), only worth it if the content-free-through-Expo hop is deemed
  too much metadata exposure.

## 7. Gate-timeout coordination

- `GATE_TIMEOUT_MS` = 5 min. A push must land fast; Expo/APNs/FCM are typically seconds.
- If the user opens the app **after** the gate timed out, the gate has fail-closed to the cloud
  outbox (existing behavior). The tap should still land somewhere useful — the run's outbox
  result — rather than a dead gate. Consider (decision, §9) **extending the timeout for gates
  that pushed** so a person woken by a push has a realistic window to act.
- The reconnect re-emit (§5.4) must only re-emit gates **still open** in `pendingGates`.

## 8. Failure modes & fallback

- Push undelivered / ignored → the gate still fail-closes to the **cloud outbox** exactly as
  today. Push is an *enhancement*, never load-bearing for correctness.
- Token stale (`DeviceNotRegistered`) → pruned on the send receipt.
- Multiple devices → push all; whichever attaches first answers; the harbor resolves the gate
  once and the others show it already handled.
- Relay can't see content → by design; it only ever sees the content-free `push_wake` + presence.

## 9. Open decisions to lock before building

1. **Expo push vs direct APNs/FCM** for P1 (recommend Expo).
2. **Grace window** before pushing (0 vs ~3–5 s) to avoid pushing a device that's about to
   reconnect.
3. **Extend gate timeout on push?** (better UX vs. holding a harbor session longer).
4. **Presence source of truth** — confirm `relayHub` exposes per-account/family app-socket
   presence cheaply (Redis key). If not, add it.
5. **Payload routing granularity** — `familyId` only, or also `termId`/run id (still non-content)
   for a precise deep-link.

## 10. Phasing

| Phase | Scope |
|-------|-------|
| **P1** | Token register/unregister + `pushService` (Expo) + `push_wake` frame + relay offline-gate + harbor `sendPushWake` + **`onAttachment` re-emit** + content-free payload + tap-to-open-gate. |
| **P2** | Interactive **Approve/Hold** notification actions (works when the app can be woken to a background task that re-establishes the relay; degrade to open-app if not). |
| **P3** | Direct APNs/FCM (drop Expo intermediary); multi-device de-dupe polish; optional gate-timeout extension. |

## 11. Test plan

- **Unit:** `pushService` token pruning; relay offline-gate (present→no push, absent→push);
  `push_wake` auth rejection for a non-owning socket.
- **Integration:** harbor opens gate with no app connected → exactly one content-free push per
  account; app attaches → harbor re-emits the open gate → answer resolves it.
- **Privacy assertion (must-have test):** the outbound push payload contains **no** workflow
  name / gate prompt / step text — only the fixed localized string + routing ids.
- **Device manual:** kill the app fully; trigger an overnight gate; confirm the push wakes it and
  tapping lands on the gate; answer; confirm `send` unblocks.
