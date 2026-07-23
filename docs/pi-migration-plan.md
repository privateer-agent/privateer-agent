# Privateer → Pi migration plan

Rebuild `privateer-agent` on the Pi toolkit (`@earendil-works/pi-*`), replacing the
buggy agent loop (`engine/QueryEngine.ts`) and Ink TUI (`components/`) while
**preserving the privateer moat**: safe-by-default permissions, TEE/Tinfoil
attestation, the 20-provider surface, and — untouched on the wire — the relay/login
connection to the privateer app.

Status: feasibility GREEN, both load-bearing risks spike-verified 2026-07-07 (see
`memory/pi-rewrite-feasibility.md` and the working skeleton in
`scratchpad/pi-spike/`). This plan sequences the actual work.

---

## 0. Framing & non-negotiables

**The wire protocol does not change.** The relay frame protocol lives in
`src/remote/relayClient.ts`, which we KEEP. That means the **privateer server and
mobile app need zero changes** — this is a CLI-only rewrite. Huge derisk for the
"port the connection" goal: we're re-hosting the agent under the same relay contract,
not redesigning the system.

**The coupling seam is two contracts.** Everything preserved talks to the agent
through exactly: (1) the `EngineEvent` vocabulary (`src/engine/events.ts`) and
(2) the permission gate (`src/permissions/gate.ts`). The migration is: make Pi emit
(1) via an adapter, and satisfy (2) via a `tool_call` extension.

**Two new load-bearing modules** (neither exists today, both spike-proven):
- `bridge/engineAdapter.ts` — `session.subscribe` event → `EngineEvent[]`.
- `attest/dispatcher.ts` — process-wide undici global dispatcher that intercepts
  provider TLS and does the Tinfoil SPKI check out-of-band (Pi extensions can't reach
  the TLS layer; this can).

**Repo decision (settled):** fresh package `privateer-agent@0.3` in a **new git
repo**. The loop + TUI are 100% replaced, so an in-place mutation fights the old
architecture the whole way. Port the preserved modules in as a self-contained set.

**Dependencies:** ADD `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
`@earendil-works/pi-tui`, `undici`, `typebox`. DROP `ai`, `@ai-sdk/*`, `ink`,
`ink-*`, `react`, `@types/react`. KEEP `ws`, `zod` (config only), `picomatch`.

**Config home (settled): one tree — Pi nested under the privateer home.** At boot,
**before any Pi import**, set Pi's agent dir inside `PRIVATEER_HOME`:

```js
process.env.PI_CODING_AGENT_DIR ??= join(globalDir(), "agent"); // globalDir() honors PRIVATEER_HOME
```

The env var is the LOAD-BEARING lever, not the `agentDir` option: many Pi internals
(`settings-manager`, `auth-storage`, `model-registry`, `migrations`, `sdk`) call
`getAgentDir()` directly and ignore the option. (Confirm the literal var name against
the installed constant — `ENV_AGENT_DIR = ${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`,
`PI_CODING_AGENT_DIR` for `APP_NAME="pi"`.) Resulting layout:

```
~/.privateer/                 ← PRIVATEER_HOME (one tree)
├── credentials.json          relay/account JWT   (KEEP — privateer identity)
├── config.json               webhooks/remote/posture prefs (KEEP — ours, Pi never reads it)
├── routines/                 (KEEP)
└── agent/                    ← PI_CODING_AGENT_DIR
    ├── auth.json  models.json  settings.json  trust.json
    ├── sessions/             (replaces the old projects/ session store)
    └── extensions/           our gate + posture extensions
```

Rationale: single backup/inspect/delete tree; honors `PRIVATEER_HOME`; **zero
collision** with a user's standalone Pi at `~/.pi/agent` (we never read/write it —
posture + no clobbering their `models.json`/`trust.json`); preserves the existing
account-JWT (`credentials.json`) vs. provider-keys (`agent/auth.json`) split. Do NOT
share keys with a personal `~/.pi` by default (opt-in importer later). Old
`~/.privateer/projects/` sessions are not Pi-readable: **abandon by default** for the
0.3 major; write a one-shot JSONL importer only if session continuity matters.

---

## 1. File-by-file disposition

Legend: **KEEP** (port ~verbatim) · **ADAPT** (port with edits) · **REWRITE**
(net-new against Pi) · **CONFIG** (becomes data, not code) · **DELETE** (Pi provides
it natively).

| Area | Files | Disposition | Notes |
|---|---|---|---|
| Agent loop | `engine/QueryEngine.ts`, `engine/router.ts` | **DELETE** | Replaced by `pi-agent-core`. Compaction, retries, idle/turn watchdogs, cache breakpoints all native. |
| Event vocab | `engine/events.ts` | **KEEP** | Becomes the relay wire type only. The adapter's output type. |
| Error mapping | `engine/errors.ts` | **ADAPT** | `describeError`/`isAccountCapCode` reused by adapter + relay + auth. Re-point at Pi's error shapes. |
| Relay | `remote/relayClient.ts` | **KEEP** | Untouched. Fed by the new adapter. |
| Attestation | `providers/attestation.ts` | **ADAPT → `attest/`** | Logic (SEV-SNP report parse, SPKI match, Tinfoil transport) moves into the out-of-band dispatcher. |
| Posture/badges | `providers/capabilities.ts`, `resolve.ts`, `components/useTeeShield.ts`, `useZdrShield.ts` | **ADAPT** | Posture computation kept; UI re-rendered in pi-tui (§6). |
| Provider registry | `providers/registry.ts`, `models.ts`, `catalog.ts` | **CONFIG** | Emit `agent/models.json` from our catalog (14/21 already built-in `pi-ai` factories; a tiny generator replaces the registry). 2 code-blockers: `venice` (body hook), `privateer` (OAuth). See Appendix A. |
| Permissions | `permissions/gate.ts`, `uiGate.ts`, `mode.ts`, `danger.ts`, `protected.ts` | **ADAPT → gate extension** | One `pi.on("tool_call")` handler + `tool_result` for redaction. Local + remote branches. |
| Auth | `auth/privateer.ts` | **KEEP** | Self-contained REST/WS/ticket. No agent-loop deps. |
| Crypto | `crypto/outboxSeal.ts` | **KEEP** | Untouched. |
| Redaction/util | `util/redact.ts`, `images.ts`, `limit.ts`, `attachmentStore.ts` | **KEEP** | `redact` reused in gate, `tool_result`, and the dispatcher. |
| Harbor | `harbor/index.ts`, `ipc.ts` | **ADAPT** | Drive `createAgentSession({sessionManager: inMemory})` (or orchestrator RPC children) instead of `createSession`. IPC unchanged. |
| Routines | `routines/*` | **KEEP** (logic) | Scheduler/trigger/delivery/store unchanged; harbor rewire only. Pi orchestrator gives the process-supervision half, NOT scheduling — we keep cron/trigger. |
| Tools (Pi has native) | `tools/read.ts`, `grep.ts`, `glob.ts`, `walk.ts`, `edit.ts`, `write.ts`, `bash.ts` | **DELETE** | Pi builtins: `read/bash/edit/write/grep/find/ls`. Verify parity of options; keep our prompt-guidelines via `promptSnippet`. |
| Tools (custom) | `tools/routine.ts`, `sendFileToClient.ts`, `saveAttachment.ts`, `memory.ts`, `skill.ts`, `task.ts`, `worktree.ts`, `web.ts`, `askUser.ts`, `todo*.ts`, `context.ts`, `exec.ts`, `processRegistry.ts` | **ADAPT** | Port to `defineTool`/`registerTool`. Schema **Zod → TypeBox**; `execute()` bodies port directly. `askUser` → `ctx.ui`. `context.ts` guards (`resolveInCwd`/`guardScope`) reused by ported tools. |
| Sessions/checkpoints | `memory/checkpoints.ts`, branching in `session.ts` | **DELETE** | NATIVE: `SessionManager` append-only tree, `createBranchedSession(leafId)`, labels, `session_before_fork`. Rewire `/fork`,`/rename`,`/resume` to Pi. |
| Auto-memory | `memory/auto.ts`, `store.ts` | **ADAPT** | Port as a tool + `agent_end`/`turn_end` extension hook. |
| Skills | `skills/loader.ts`, `installer.ts` | **ADAPT** | Pi has a skills system. Port `.privateer-skill.json` provenance + `/skills update` as an extension, or map onto Pi's skill dirs. |
| Commands | `commands/registry.ts`, `custom.ts` | **ADAPT** | `pi.registerCommand`. Port `/remote-access`, `/verify`, `/model`, `/fork`, etc. |
| Hooks | `hooks/engine.ts` | **ADAPT** | Map to Pi extension events (`before_agent_start`, `tool_call`, `tool_result`, `turn_end`). |
| MCP | `mcp/client.ts`, `oauth.ts` | **DELETE / ADAPT** | Prefer Pi's native MCP. Keep our OAuth only if Pi's is insufficient. |
| Context | `context/systemPrompt.ts`, `projectInfo.ts`, `outputStyles.ts` | **ADAPT** | Content ports into Pi `SYSTEM.md`/`APPEND_SYSTEM.md` + settings. |
| Agents/subagents | `agents/loader.ts`, `tools/task.ts` | **ADAPT** | Map onto Pi sub-agents / orchestrator. |
| Config | `config/schema.ts`, `load.ts`, `paths.ts` | **ADAPT** | Keep privateer-only config in `config.json` read by our code (webhooks, remote-access, posture, redaction). Move model/provider selection to `agent/models.json`. Home settled: `PI_CODING_AGENT_DIR = $PRIVATEER_HOME/agent`, set at boot (§0). |
| TUI | `components/*.tsx` (24 files) | **REWRITE** | On `pi-tui`. The big chunk — and the buggy layer we're replacing. |
| Entry | `main.tsx`, `session.ts`, `version.ts` | **REWRITE** | New bootstrap: install attestation dispatcher FIRST, then Pi session/TUI. |

---

## 2. Phased sequence

Each phase ends in something runnable and independently verifiable. Phases 1–5 are
headless (no TUI) so the whole agent + relay is provable before the UI rewrite.

### Phase 1 — Headless core + EngineEvent adapter  *(skeleton exists in spike)*
**Goal:** `createAgentSession` headless, driven by a prompt, emitting `EngineEvent`s.
- Port `bridge/engineAdapter.ts` from `scratchpad/pi-spike/adapter.mjs` (harden: map
  `compaction_*`, `auto_retry_*` → `retrying`, `agent_end` errors → `error`).
- Thin `session.ts` wrapper: `createSession()` → `{ session, subscribeAsEngineEvents() }`.
- **Verify:** headless prompt against a real key → `EngineEvent` stream matches the
  old shape. Port `tests/engine.test.ts` to assert the adapter mapping.

### Phase 2 — Permission gate extension  *(spike-proven)*
**Goal:** safe-by-default gate with local + remote decision paths.
- `ext/permissionGate.ts`: `pi.on("tool_call")` porting `gate.ts`/`danger.ts`/
  `protected.ts`/`mode.ts` policy. Local path → `ctx.ui`; remote path → await the
  relay (the `uiGate.getRemote` logic). `tool_result` hook → `redactText`.
- Wire `ctx.signal` + timeout so a hung remote approver can't wedge a turn.
  Fail-closed on throw (already Pi's behavior).
- **Verify:** port `tests/permissions.test.ts`. Assert deny blocks, allow runs,
  bypass/no-quarter modes, dangerous-action escalation, abort mid-approval.

### Phase 3 — Providers as config + attestation dispatcher (THE MOAT)  *(spike-proven)*
**Goal:** all 20 providers selectable; TEE/Tinfoil attestation live.
- `providers/genModelsJson.ts`: generate `$PRIVATEER_HOME/agent/models.json` from our catalog
  (built-in factories used directly; custom OpenAI-compat via `baseUrl`+`api`).
- `attest/dispatcher.ts`: `setGlobalDispatcher(new Agent({ connect: wrapped }))`
  installed at process start. Port `attestation.ts` (SEV-SNP parse, SPKI match,
  Tinfoil transport). **Cache attestation per-host on `connect`** (undici pools
  sockets — the hook only fires on NEW connections; mirror the old baseURL cache).
- Posture/ZDR badge computation kept (render deferred to §6).
- **Verify:** live smoke against `inference.tinfoil.sh` → green posture; SPKI matches
  the report. (Spike already proved interception + SPKI extraction.)

### Phase 4 — Connection layer (relay + harbor + login)
**Goal:** drive this terminal from the privateer app, unchanged on the wire.
- KEEP `remote/relayClient.ts`, `auth/privateer.ts`, `crypto/outboxSeal.ts` verbatim.
- Wire `RelayClient` to the Phase-1 adapter + Phase-2 remote gate branch.
- Port `harbor/` to drive headless sessions; `routines/*` logic unchanged.
- Reconcile trust: headless modes must NOT auto-trust — set `defaultProjectTrust`
  in `agent/settings.json` and never pass `-a` in the harbor; keep our permission
  gate as the real safety. (Config home already pinned via `PI_CODING_AGENT_DIR` — §0.)
- **Verify:** real app ↔ CLI round-trip — prompt down, events up, approval relayed,
  file transfer both ways, no-quarter toggle, routine result push. Port
  `tests/routineDelivery.test.ts`, `tests/outboxSeal.test.ts`.

### Phase 5 — Tools
**Goal:** full tool surface.
- DELETE tools Pi provides; confirm option parity (esp. `edit`/`bash` semantics).
- ADAPT custom tools to `registerTool` (Zod→TypeBox). Reuse `context.ts` scope guards.
- **Verify:** port `tests/tools.test.ts`. Each custom tool exercised headless.

### Phase 6 — TUI on pi-tui  *(the big rewrite)*
**Goal:** interactive parity with the Ink UI.
- Rebuild `components/*` as pi-tui: Transcript, PromptInput, StatusBar, ModelPicker,
  SessionPicker, ApprovalPrompt, Onboarding, PrivateerLogin, TodoPanel, banners,
  posture/TEE/ZDR badges (§3 data).
- Map slash commands via `registerCommand`; keybindings via `registerShortcut`.
- **Verify:** port `tests/tui.test.ts`, `promptInput.test.ts`. Manual `/run`-style
  drive of a real session. Note: live token ticking is Anthropic-only (OpenAI-compat
  providers report usage at end-of-turn) — render per-turn for those.

### Phase 7 — Parity cleanup & cutover
- Wire native sessions to `/fork`, `/rename`, `/resume`, `/clone`; delete
  `checkpoints.ts`. Port auto-memory, skills provenance, hooks, custom commands.
- Config home already settled (§0); finalize MCP (prefer Pi native), first-run
  scaffolding of `agent/` + generated `models.json` + safe `defaultProjectTrust`.
- Full suite green; `README` + install script; publish `0.3.0`.

---

## 3. Risk register (post-spike)

| Risk | Status | Mitigation |
|---|---|---|
| Relay survives the loop swap | **RESOLVED** (spike B) | adapter + gate proven end-to-end |
| TEE attestation survives | **RESOLVED** (spike A) | out-of-band undici dispatcher; SPKI extracted |
| Live token counter fidelity | Known limit | Anthropic live; others per-turn. Acceptable. |
| Headless auto-trust footgun | Design item | Gate is the real safety; never `-a` in harbor; set `defaultProjectTrust`. |
| `edit`/`bash` builtin semantics differ | Verify in P5 | Diff against our tools; keep ours if divergent. |
| Pinning to Pi internals (dispatcher, hooks) | Ongoing | Adapter + dispatcher are the only tight couplings; both small and covered by tests. Consider upstreaming a `fetch` option to `pi-ai`. |
| Concurrent tree edits by user | Process | Fresh repo/worktree; never `git add -A`. |

---

## 4. Effort shape

Net **subtraction** in three areas (delete loop, delete checkpoints/branching, provider
code → config) offsets the **one addition** (pi-tui rewrite). New code is small and
concentrated: the adapter (~120 LOC, done), the gate extension (~150 LOC), the
attestation dispatcher (~200 LOC + ported parse logic), the models.json generator.
The moat survives; the buggy layers don't. Recommended order is strictly Phases 1→7;
1–5 keep the whole system provable headless before the UI is touched.

---

# Appendix A — Phase 3 checklist (providers-as-config + attestation dispatcher)

Source cites verified against `src/providers/*` and pi-ai `packages/ai/src/providers/all.ts`
(built-in set) + `packages/coding-agent/src/core/model-registry.ts` (models.json schema).

## A.1 Provider re-homing — 14 built-in, 7 config, 2 code-blockers

pi-ai `builtinProviders()` (`all.ts:70-108`) already ships: **anthropic, openai,
google, xai, groq, cerebras, deepseek, fireworks, together, mistral, minimax,
moonshotai, openrouter, zai**. These need no entry (optionally an override for the
nuances below). The remaining 7 need a `models.json` `providers.<name>` entry.

**Config-only (write a models.json entry):**
- [ ] `qwen` — `baseUrl: https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, `api: openai-completions`, key `${DASHSCOPE_API_KEY}`, `compat.thinkingFormat: "qwen"`.
- [ ] `ollama` — `baseUrl: http://localhost:11434/v1` (the OpenAI-compat surface, NOT native `/api`), `api: openai-completions`, no key.
- [ ] `nearai` — `baseUrl: https://cloud-api.near.ai/v1`, `api: openai-completions`, key `${NEARAI_API_KEY}`. (Attestation handled in A.3, not here.)
- [ ] `tinfoil` — `baseUrl: https://inference.tinfoil.sh/v1`, `api: openai-completions`, key `${TINFOIL_API_KEY}`. (Attestation in A.3.)
- [ ] `custom` — user-supplied `baseUrl` (required), `api: openai-completions`, optional key. Already config-shaped.

**Nuance overrides (built-in, but add an entry to preserve current behavior):**
- [ ] `openai` — built-in defaults to `openai-responses`; privateer uses chat completions. Override `api: "openai-completions"`.
- [ ] `minimax` — built-in is `anthropic-messages`; privateer uses `…/v1` openai-compat with inline `<think>`. Override `baseUrl: …/v1`, `api: "openai-completions"`, `compat.requiresThinkingAsText`.
- [ ] `zai` — built-in default endpoint is `…/api/coding/paas/v4`; privateer default is `…/api/paas/v4`. Set `baseUrl` explicitly; `compat.thinkingFormat: "zai"`.
- [ ] `fireworks` — pick `api: "openai-completions"` to match privateer (built-in supports both protocols).
- [ ] `deepseek` / `together` — set `compat.thinkingFormat` (`"deepseek"` / `"together"`) or reasoning silently drops.
- [ ] `openrouter` — map `enforceZdr` → `compat.openRouterRouting.zdr: true` (pi-ai has native ZDR routing, `types.ts:591`).

**CODE-BLOCKERS (cannot be config — schedule real work):**
- [ ] **`venice`** — privateer's `veniceFetch` mutates the request body to inject `venice_parameters.include_venice_system_prompt:false` (`registry.ts:56-67`). No models.json equivalent. Options: (a) a `before_provider_request` extension hook that patches the payload (Pi CAN replace the request body — verified), or (b) set it account-side and drop the hook. **Prefer (a)** — keeps it self-contained.
- [ ] **`privateer`** (account channel) — dynamic rotating JWT + 401-refresh via `authedFetch`, appends `/api/agent/v1`, TEE/ZDR split by `privateerChannel()` (`resolve.ts:47`). Not a static key. Register via pi-ai's **OAuth provider** path (`ProviderConfigInput.oauth`, `model-registry.ts:894-901`) or a custom `streamSimple`. This is the one provider that genuinely needs code parity with `auth/privateer.ts`.

## A.2 Listing filters (decide the model, once)
Privateer's live `listModels` filters — Groq `/whisper|guard|tts/` (`models.ts:117`),
plus OpenAI/Fireworks/Venice/Tinfoil filters (`models.ts:89-258`) — are NOT
representable in a static `models.json`.
- [ ] Decide: keep privateer's live listing layer on top of config-homed providers (filters stay in our code), OR bake a static pre-filtered catalog into `models.json`. Recommend keeping live listing — the filters are cheap and already written.

## A.3 Attestation dispatcher — ONLY the peer-cert capture moves
`attestation.ts` is almost entirely pure and STAYS verbatim: `interpretReport`,
`interpretTinfoilDoc` (incl. the SEV-SNP `report_data` parse at offset `0x50`, gunzip,
hardware detection, `tlsKeyMatched`), `teePosture`, `tinfoilTeePosture`, `randomNonce`,
and the NEAR paths (`fetchAttestation`, `fetchAttestationViaServer`) which are plain
HTTPS (trust is in the report body, not the channel).
- [ ] The single relocation: replace `httpsTransport` (`attestation.ts:184`, which drops to `node:https.request` to read `res.socket.getPeerCertificate().raw` → SPKI DER → sha256) with a `TinfoilTransport` backed by the out-of-band undici dispatcher's `connect` hook. Compute the SPKI fp in the connect hook exactly as `:200-201`, key it per-host, return `{ doc, liveTlsKeyFp }`.
- [ ] **No call-site changes**: `fetchTinfoilAttestation(cfg, transport?)` already injects the transport (`:231`), and `useTeeShield.loadTinfoilAttestation` is untouched. This is a transport swap only.
- [ ] Encode the pooling gotcha (spike-verified): undici reuses keep-alive sockets, so `connect` fires only on NEW connections — cache the fp per-host and don't pre-pool the attested host.
- [ ] Dispatcher install order: `setGlobalDispatcher(...)` in the 0.3 bootstrap BEFORE any Pi import (same place `PI_CODING_AGENT_DIR` is set). **UPDATE (spike 2026-07-07, `scripts/spike-ext-dispatcher.ts`):** installing at EXTENSION-INIT (after Pi is imported, before the first provider request) ALSO intercepts + captures the SPKI — Pi resolves the global dispatcher at call time. So the attestation layer can ship as a PURE `pi-tee` marketplace extension (no pre-Pi boot shim), provided nothing pre-pools a keep-alive socket to the attested host before the extension loads (dedicated tinfoil/near hosts satisfy this; load the extension early). privateer-agent keeps the boot-path install as belt-and-suspenders + for `PI_CODING_AGENT_DIR`.

## A.4 models.json generator
Source of truth is split — `catalog.ts` is presentation-only (label/keyHint/default/
privacy); per-model cost/context/multimodal live in the live `listModels` (`models.ts`).
- [ ] Generator reads: `KNOWN_PROVIDERS` (`schema.ts`) for provider ids + base URLs, per-provider `api`/`compat` per A.1, and live `listModels` for `id/contextWindow/maxTokens/cost/input`.
- [ ] Emit `apiKey` as env templates `${PROVIDER}_API_KEY` (matches `resolve.ts:74` + pi's `resolve-config-value.ts`); bridge privateer-stored keys into pi `auth.json` via `AuthStorage` at login (auth.json is preferred over the config value, `model-registry.ts:701-714`).
- [ ] Do NOT emit a static `apiKey` for `privateer` (OAuth) or rely on it for `venice` (body hook).
- [ ] Defaults if listing omits: `contextWindow 128000`, `maxTokens 16384`, `cost {0,0,0,0}`, `input ["text"]` (`model-registry.ts:610-622`).
- [ ] **Verify:** generate models.json, then `ModelRegistry.create(auth, path).find(provider, id)` resolves every provider; live smoke one built-in (groq) + one config (qwen) + Tinfoil green posture.

---

# Appendix B — Phase 6 checklist (TUI rewrite on pi-tui)

Path roots: `TUI/` = `.reference/pi/packages/tui/src/`, `CA/` =
`.reference/pi/packages/coding-agent/src/` (the reference UI that uses pi-tui),
`PV/` = `src/components/`. Read `TUI/index.ts` first — the whole public API on one screen.

## B.1 The mental-model shift (internalize before writing any component)
- **No React, no reconciler, no virtual DOM.** A component is
  `interface Component { render(width): string[]; handleInput?(data); invalidate() }`
  (`TUI/tui.ts:64`). It returns pre-wrapped, ANSI-colored lines ≤ width (the TUI throws
  if a line exceeds width — use `truncateToWidth`/`wrapTextWithAnsi`/`visibleWidth`).
- **State = instance fields. Re-render = mutate + `ui.requestRender()`** (coalesced,
  differential, 16 ms). Safe to call on every streaming token. → the ~40 `useState` in
  `App.tsx` and every `useEffect` become fields + methods.
- **No flex/Yoga.** Vertical = child order in a `Container`. Horizontal / right-align /
  space-between = **composed by hand** with `visibleWidth` + space padding. This is the
  single pervasive porting tax (template: `CA/.../components/footer.ts:201`).
- **Root:** `class TUI extends Container`; stack slots in display order
  (`chatContainer → status → editor → footer`), `setFocus(editor)`, `start()`. Streaming
  is a reducer over agent events (`handleEvent` switch, `CA/.../interactive-mode.ts:2753`).

## B.2 Primitives that do the heavy lifting (don't rebuild these)
- [ ] **`Editor`** (`TUI/components/editor.ts:252`) — multi-line input with prompt
  history, `/`+`@`+`#` autocomplete dropdown, bracketed paste, kill-ring, undo. Gives
  ~90% of `PromptInput`. Only extra to port: **vim modes + reverse-search** (add via app
  key handlers, like CA's `CustomEditor`).
- [ ] **`Markdown`** (`TUI/components/markdown.ts:110`) — marked-based, themed, tables,
  syntax highlight, streaming-safe. **Delete `PV/Markdown.tsx`**, feed `getMarkdownTheme()`.
- [ ] **`SelectList`** / **`SettingsList`** — windowed scrolling lists (`select-list.ts:40`,
  `settings-list.ts:34`). **`Input`** (`input.ts:19`) replaces `ink-text-input` 1:1.
- [ ] **`Loader`/`StatusIndicator`** self-animate (`loader.ts:83`) — replaces `ink-spinner`
  (heed the existing selection-wipe/flicker warnings). **`DynamicBorder`** replaces
  `borderStyle="round"` (top/bottom rules; hand-draw `╭╮╰╯` only if you must).
  **`Box`/`Text`** = padded background card / wrapped text leaf.
- [ ] **Overlays:** `ui.showOverlay(component, opts)` (z-stack, `tui.ts:493`) OR the
  editor-swap the reference actually uses for pickers (`showSelector`, `interactive-mode.ts:3985`).

## B.3 Free wins & deletions
- [ ] **Delete `PV/useTerminalWidth.ts`** — width is the `render(width)` arg; resize auto-redraws.
- [ ] **`<Static>` → `chatContainer.addChild(finalizedComponent)` once, never mutate** —
  scrollback + the line-diff replace it; the `resizeNonce` remount hack is gone.
- [ ] **`PV/figures.ts`, `spinnerVerbs.ts` — used unchanged.** `theme.ts` — adopt CA's
  `Theme` model (palette + `fg(color,text)`/`bold` fns as a module singleton), keep
  `MODE_COLOR`/`POSTURE_COLOR`/`toolDisplayName` maps as-is.
- [ ] **`PV/useTeeShield.ts` / `useZdrShield.ts` — keep the promise-cache modules VERBATIM**
  (framework-agnostic). Replace only the `useEffect+useState` wrapper with a `TeeState`/
  `ZdrState` field + an async loader that `requestRender()`s on settle.

## B.4 Component build order + difficulty
Build foundation → transcript+input → orchestrator → pickers/dialogs → polish.

| # | privateer file | approach | CA crib | diff |
|---|---|---|---|---|
| 1 | `theme.ts` | palette + `fg`/`bold` singleton; keep posture/mode maps | `theme/theme.ts:323` | moderate |
| 2 | `figures.ts`, `spinnerVerbs.ts` | unchanged | — | trivial |
| 3 | `Markdown.tsx` | **delete** → pi-tui `Markdown` | `markdown.ts:110` | trivial |
| 4 | `StatusBar.tsx` | manual left/right compose; badge segments as colored `Text` | `footer.ts:83` | moderate |
| 5 | `Transcript.tsx` | keep `Entry`/`groupRows`; one `Component` per kind; stream row = one persistent component re-`setText` | `assistant-message.ts`, `user-message.ts` | moderate |
| 6 | `PromptInput.tsx` | wrap `Editor`; port vim + reverse-search only | `Editor` + CA `CustomEditor` (`interactive-mode.ts:427`) | hard |
| 7 | `App.tsx` | `InteractiveMode`-style orchestrator: fields not `useState`, event→UI reducer, pickers via editor-swap/overlay | `interactive-mode.ts:626/2753/3985` | hard |
| 8 | `ModelPicker.tsx` | `Container`+`Input` filter+windowed list, per-row privacy badges, setup/login callbacks | `model-selector.ts:35` | hard |
| 9 | `SessionPicker.tsx` | windowed `sessionTreeRows`; delete-confirm sub-mode | `session-selector.ts:685` | moderate |
| 10 | `ApprovalPrompt.tsx`, `RewindPicker.tsx`, `PlanConfirm.tsx` | `DynamicBorder` frame + `handleInput` key map | `trust-selector.ts:32` | trivial |
| 11 | `OptionPicker.tsx` | `SelectList` + custom-answer sub-mode (`Set` for multiSelect) | `select-list.ts` | moderate |
| 12 | `Onboarding.tsx` | stepped wizard, `step` field rebuilds; `Input` for keys | `first-time-setup.ts:32` | moderate |
| 13 | `PrivateerLogin.tsx` | `AbortController` + poll method → `requestRender()`; keep no-spinner choice | `login-dialog.ts:11` | moderate |
| 14 | `ToolCallView.tsx` | state-colored header `Container`; `EditDiff` → `renderDiff()` | `tool-execution.ts:13`, `diff.ts:79` | moderate |
| 15 | `AgentGroupView.tsx` | string-composed `├└│` tree rows; `Loader` spinner | `tool-execution.ts` | moderate |
| 16 | `Banner.tsx` | zip ANCHOR ascii + text lines manually (no flex) | header `interactive-mode.ts:721` | moderate |
| 17 | `TodoPanel.tsx`, `ModeHint.tsx` | glyph lines / manual right-align + `keyHint()` | `keybinding-hints.ts:42` | trivial/moderate |
| 18 | shields wiring | `TeeState`/`ZdrState` fields + async loaders on StatusBar | (no analog) | moderate |

## B.5 No-analog handling (the porting taxes)
- **Horizontal flex / `justifyContent`** — none; hand-compose with `visibleWidth`+padding everywhere (StatusBar, ModeHint, Banner). Most pervasive tax.
- **Rounded borders** — none; `DynamicBorder` (top/bottom rules) is idiomatic, or hand-draw box chars.
- **TEE/ZDR badges** — no toolkit flow; keep the promise caches, render colored `Text` (dim while loading, `POSTURE_COLOR` when resolved).
- **Verify Phase 6:** manual drive of a real interactive session (`/run`-style) covering stream, tool approval, model/session pickers, login, resize. Live token ticking is Anthropic-only (§Phase 6 note) — render per-turn for other providers.
