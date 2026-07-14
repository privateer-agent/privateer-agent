# Workflows on Mobile — UX & Sharing Plan

> Companion to [`daemon-channels-and-app.md`](./daemon-channels-and-app.md) §8
> (Workflows). That doc specifies the **agent/daemon** side (schema, runner, store,
> control, relay wiring — all built and tested). This doc specifies the **Privateer
> app** side: how workflows are surfaced, run, authored, and — the highest-value
> part — **shared (upload/download)**.
>
> Status: **Phases 1–2 built** (2026-07-13). Daemon side: `src/workflows/*`,
> `src/remote/workflowsControl.ts`, the `workflows_*` relay frames, `tests/workflows.test.ts`.
> App side: Phase 1 (manage & run) + Phase 2 (file/link sharing) — see the phasing table (§6)
> for the built-vs-remaining breakdown. Phase 3 (linear editor) and Phase 4 (gallery) remain.

---

## 0. Decisions locked

Two product forks were decided up front; the rest of this plan assumes them:

| Fork | Decision | Consequence |
|------|----------|-------------|
| **Mobile authoring depth** | **Linear step editor** (not a full node canvas, not run-only) | Steps as a reorderable tap-to-edit list with branch chips; deep graphs nudge to desktop. Reuses the `RoutinesScreen` field vocabulary. |
| **Sharing model first** | **File + link first** (not gallery-first) | OS share sheet + `privateer://` deep links + a local-re-sign import gate. **Zero new server trust.** A server-hosted gallery is deferred to a later phase. |

---

## 1. Two framing truths

1. **Driving a workflow needs no new crypto.** `client/services/accountSign.ts` already
   exposes a *generic* `signControl({ termId, ts, action, args })`. The three new
   mutations (`workflows_save` / `workflows_remove` / `workflows_run`) are just new
   `action` strings through the identical path `routines_save` already uses. The daemon
   verifies them (`guardControl`; `workflows_run` is in the STRICT replay set). So
   "Phase 1: manage & run" is small.

2. **A workflow is not private-by-definition content.** A chat is E2EE because its whole
   nature is private. A **workflow is a recipe — its value is being shareable.** That
   distinction is what makes upload/download high-value, and it's also why *sharing
   deliberately crosses the E2EE boundary* and must be explicit and consent-gated. Private
   workflows stay local/E2EE; only an explicit publish/export moves one outward.

---

## 2. The hero is Run & Gate, not the editor

The instinct is to build a graph editor. That is the wrong center of gravity for mobile.
The high-frequency action is **watching a workflow run and answering its gates from your
phone** — the "automation I carry in my pocket" moment. Authoring a DAG is a
once-per-workflow, lean-back, desktop-shaped task.

```
┌─ Morning Triage ────────────── ●live ┐
│  ✓ scan          5 items found        │
│  ✓ draft         5 replies drafted    │
│  ▶ gate          waiting on you…      │   ← push notification fired
│    ┌─────────────────────────────┐    │
│    │ Send 5 drafted replies?      │    │
│    │  [ Approve ]   [ Hold ]      │    │   ← this IS the relay select_request
│    └─────────────────────────────┘    │      (askGate → requestSelect, already wired)
│    send          (blocked)            │
└───────────────────────────────────────┘
```

Why this is mostly already built:
- The `human_gate` → `requestSelect` → app picker path exists end-to-end (daemon
  `askGate`, `resolveGate`, `GATE_TIMEOUT_MS`; the app's existing select UI renders it).
- The runner emits `step_start` events; the daemon forwards them as feed notices.
- The runner **fail-closes** unattended script steps to `deferred`. The mobile answer to
  "deferred" is **"tap the notification to approve and resume"** — a feature, not a limit.

Add a **push on gate-wait** (`PushNotification`) and gated overnight automation feels alive.

---

## 3. Authoring — the linear editor

Editing an arbitrary routed graph on a phone is genuinely hard, so we don't. A workflow is
shown as a **linear, reorderable step list**; each step is tap-to-edit using the same
field vocabulary as `RoutinesScreen` (TextInput / chips / `ModelPickerField`). A step
editor ≈ the routine editor, per step:

- name, `type` (agent / script / human_gate / set / wait), prompt or command, tools
- a "then go to →" target picker; a single conditional route renders as a `→ if score≥8`
  chip. Branching beyond one condition shows an **"edit on desktop"** affordance rather
  than a cramped on-device graph tool.

Most real workflows are near-linear, so this covers the 80% and stays honest about the
20% that wants a bigger screen.

---

## 4. Screen inventory (mirrors the manager pattern)

Entry point: a **Workflows** row on the "Privateer Routines" terminal card in
`client/components/LiveTerminalsList.tsx`, next to Routines/Channels (all daemon-owned).

| Screen | Purpose |
|--------|---------|
| `WorkflowsScreen` | List. Cards: `name · N steps · ⚠ scripts`. Actions: Run / Edit / Share / Delete. Clone of `RoutinesScreen`'s nav+card+banner skeleton. |
| `WorkflowRunScreen` | The hero (§2). Live step progress, gate answering, final result (also lands in the "Recent results" outbox). |
| `WorkflowEditorScreen` | The linear step editor (§3). |
| `ImportPreviewScreen` | The sharing security gate (§5). |
| *(later)* `WorkflowGalleryScreen` | Deferred — server registry browse/search. |

`contexts/RemoteDriveContext.tsx` gains a `workflows` block cloned from `routines`:
`workflows` state (`items`, `detail`, `busy`, `message`), and
`listWorkflows` / `getWorkflow` / `saveWorkflow` / `removeWorkflow` / `runWorkflow`, each
mutation calling `signControl` with the new action string. New frame handlers: `workflows`
(summaries), `workflow` (detail); the existing `select_request` handler feeds the run
screen's gate card.

---

## 5. Upload / download — the high-value part

Nobody wants a blank-screen authoring experience; everybody wants to install
**"Weekly repo digest"** or **"Inbox triage"** and tweak it. This is the growth loop.

### 5.1 A workflow is already a portable artifact

It's strict-schema JSON. The shareable file:

```json
{
  "formatVersion": 1,
  "workflow": { "…the graph, with an input: schema…": true },
  "meta": { "title": "Morning Triage", "description": "…",
            "tags": ["email", "daily"], "author": "optional" }
}
```

On import the `id` is regenerated (no collisions). The graph's `input:` params are the
mechanism that makes a recipe portable — no hardcoded paths/values.

### 5.2 File + link sharing (the MVP — no server, privacy-native)

- **Share:** `exportWorkflow(wf)` → sanitization pass → OS share sheet (AirDrop, Messages,
  Slack) **or** a deep link `privateer://workflow/<deflate+base64>`.
- **Import:** accept a file or a `privateer://workflow/*` link → `ImportPreviewScreen`.

This adds **zero server trust** and fits the architecture exactly — a shared workflow never
crosses the E2EE boundary; it moves peer-to-peer.

### 5.3 The import security gate (the centerpiece)

Non-negotiable, because a shared workflow can contain a `script` step = RCE. The preview is
an app-store-style manifest:

```
┌─ Import: “Weekly Repo Digest” ────────┐
│ by @someone · 4 steps                  │
│ This workflow will:                    │
│   🤖 Run 2 AI steps (read-only tools)  │
│   ⚠️  Run shell commands: git, jq      │   ← red, prominent
│   ⏸  Ask you before: posting digest    │
│   📥 Needs input: repo path            │
│  [ Add to my workflows ]               │   ← extra confirm if scripts present
│  [ Import without script steps ]       │   ← strips scripts → human_gate stubs
└────────────────────────────────────────┘
```

The trust chain does **not** depend on trusting the publisher:

1. **Import re-signs locally.** "Add to my workflows" makes *your* device sign the
   `workflows_save` with *your* account key. The publisher's identity grants nothing;
   execution trust is entirely your local signature. A malicious artifact can't run on your
   daemon unless you import it.
2. **The manifest surfaces every script command** before you commit — informed consent.
3. **The runner already fail-closes.** Unattended scripts defer to approval; attended ones
   require an explicit in-app approve at run time. An imported script can't fire silently.
4. **"Import without scripts"** rewrites `script` steps into `human_gate` stubs — a
   paranoid-safe install for untrusted sources.

Publisher Ed25519 signatures ("verified author" badge) and an official/curated shelf are
**trust signals, not the security floor** — add them with the gallery.

### 5.4 Sanitization on export/publish

Before an artifact leaves the device: strip absolute `working_dir`/cwd (warn, or convert to
an `input`), flag prompts that look like they carry PII/secrets, and list every script
command back to the author. Nudge hardcoded values → `input:` params so the recipe is
actually reusable.

---

## 6. Phasing (with file-level tasks)

| Phase | Scope | Key files |
|-------|-------|-----------|
| **1. Manage & Run** ✅ built | List, run, delete, live monitor + gate answering, light edit (push-on-gate still TODO) | `RemoteDriveContext.tsx` (workflows block + `signControl`), `WorkflowsScreen.tsx`, `WorkflowRunScreen.tsx`, `LiveTerminalsList.tsx` (entry row) |
| **2. Share (file/link)** ✅ built | Export artifact + sanitization + import security gate + local re-sign + `privateer://workflow/<base64url>` deep link | `services/workflowShare.ts`, `ImportPreviewScreen.tsx`, `WorkflowsScreen.tsx` (Share/Import wiring), `App.tsx` (screen + linking) |
| **3. Linear authoring** | Step-list editor | `WorkflowEditorScreen.tsx` |
| **4. Gallery** *(deferred)* | Server registry, browse/search, curated set, publish + verified badges | new server surface + `WorkflowGalleryScreen.tsx` |

**Phase 2 notes (as built):** deep-link payload is base64url of the artifact JSON — **no deflate
yet** (pako isn't a dep); large graphs should share as a *file*, not a link (§5.2). The import
target terminal is the caller's `familyId` (from WorkflowsScreen) or the active drive session's
`termId`; a cold deep link with neither shows a "open your Routines terminal first" notice rather
than guessing. `services/workflowShare.ts` is pure logic and was exercised end-to-end (export→link→
decode→manifest→strip→draft + all error codes). Not yet driven on a device/simulator.

Phase 1 is small (crypto + daemon already exist and are tested) and delivers the hero UX.
Phase 2 is the high-value download/upload MVP with **no new server trust**.

**Phase 1 UI revision (2026-07-14).** The first-cut screens shipped functional but flat; the
list was four look-alike text links and the monitor a plain text feed. Redesigned over the
*same* `RemoteDriveContext` data (no new frames, no new crypto):

- **`WorkflowsScreen` card** — a filled primary **Run** button with the secondary actions
  (Monitor / Share / Delete) moved into an overflow (`Alert` action sheet); a **composition
  bar** built from the real summary counts (agent = navy, gate = amber, script = red, widths
  proportional — explicitly *not* a sequence, since the graph is routed); "Runs shell" recolored
  red to match the script segment and the import gate. State pills were **deliberately not**
  added — `WorkflowSummary` carries no run-state, so any live/idle badge would be fabricated.
- **`WorkflowRunScreen`** — the flat feed became a **typed step timeline** grounded in real
  data: nodes come from `getWorkflow` (`workflows.detail`) with each step's real `type` and its
  `routes`' `when:` conditions rendered as `→ if <expr> → <target>` chips; live status is
  overlaid from signals the daemon actually emits — the runner's `▶ <stepName>` step-start
  notices and the `pendingSelect` gate. Falls back to the raw feed if the graph can't load. The
  gate became a labelled decision sheet (affirmative option last); **no countdown** was shown
  because `PendingSelect` carries no deadline over the wire.
- **i18n:** 10 new `workflows.*` keys added at parity across all 9 locales
  (`more`/`live`/`queued`/`loadingGraph`/`resultHeader`/`gateHint`/`route{If,Always,End,Fail}`).

Typechecks clean; not yet driven on a device. Still TODO from the redesign proposal:
push-on-gate (interactive lock-screen Approve/Hold), Live Activity, and an empty-state
starter-recipe on-ramp.

**Push-on-gate (2026-07-14).** Client-side *local* notifications are wired
(`treeview/client/services/notificationService.ts` + a `pendingSelect`/AppState effect in
`RemoteDriveContext.tsx`; `expo-notifications ~0.32.17` added to package.json + app.json — needs
`npm install` + a dev-client rebuild to activate). That covers a *backgrounded-but-alive* app.
Waking a *fully-killed* app needs server-sent push — specced (design only, low priority) in
[`push-on-gate-server.md`](./push-on-gate-server.md): content-free wake via a daemon `push_wake`
frame → relay offline-check → Expo push, plus the `onAttachment` gate re-emit.

---

## 7. Open items / dependencies

- **Runner template engine — DONE (2026-07-13).** The `runner.ts` placeholder was replaced
  by `src/workflows/expr.ts`, a confined, dependency-free recursive-descent interpreter
  (Jinja-ish subset: `and/or/not`, comparisons with numeric coercion, `in`/`not in`,
  arithmetic, `| filters`, `.`/`[expr]` paths). **No `eval`/`Function`**, prototype-safe
  path lookups (blocks `__proto__`/`constructor`/`prototype` + inherited members), DoS bounds
  (input length / node count / recursion depth). `evalCondition` fails CLOSED (bad `when` →
  route not taken); `renderTemplate` fails LOUD (bad `{{ }}` → `TemplateError`, caught by the
  runner into a `failed` result). Covered by `tests/expr.test.ts` (13 tests incl. sandbox +
  DoS); full agent suite 269/269 green.
- **i18n — DONE (2026-07-13).** `workflows.*` (Phase 1 + 2) shipped at key parity in all 9
  client locales (en/de/es/fr/pt/pl/ja/zh/th).
- **Storage backend.** Workflows live on the daemon (the user's machine), reached over the
  relay — they are *not* app-local content, so the `cloud`/`local` storage-backend split
  doesn't apply to the graphs themselves. Shared *artifacts* (Phase 2) are transient files,
  not persisted server content.
- **The E2EE-boundary decision for a public gallery** (Phase 4): published workflows are
  intentionally-public plaintext server content — an explicit, consent-gated crossing.
  Private workflows stay local/E2EE. Does not need resolving until Phase 4.
```
