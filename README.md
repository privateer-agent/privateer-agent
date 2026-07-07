# privateer-agent 0.3

A provider-agnostic, **safe-by-default** terminal coding agent with **TEE/Tinfoil
attestation**, rebuilt on the [Pi toolkit](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
(`@earendil-works/pi-*`).

This is the `0.3` rewrite: the buggy agent loop and Ink TUI from `0.2` (in
`../tree-cli`) are replaced by Pi's native loop + `pi-tui`, while the **privateer
moat is preserved untouched** — safe-by-default permissions, TEE/Tinfoil
attestation, the 20-provider surface, and the relay/login connection to the
privateer app. The wire protocol does not change, so the **server and mobile app
need zero changes**; this is a CLI-only re-host.

Full plan and file-by-file disposition: [`docs/pi-migration-plan.md`](docs/pi-migration-plan.md).

## Status — Phases 1–2 verified

Scaffold + the load-bearing seams, promoted from the de-risking spike
(`../pi-spike`) and the 0.2 codebase (`../tree-cli`), each verified live:

| Module | Role | Source |
|---|---|---|
| `src/boot.ts` | Pins `PI_CODING_AGENT_DIR` + installs the attestation dispatcher **before any Pi import** | new (the ordering contract) |
| `src/attest/dispatcher.ts` | Out-of-band undici global dispatcher; captures enclave TLS SPKI hash | `pi-spike/spike-a.mjs` |
| `src/bridge/engineAdapter.ts` | Pi `session.subscribe` events → privateer `EngineEvent`s | `pi-spike/adapter.mjs` |
| `src/session.ts` | Thin headless session wrapper → `subscribeAsEngineEvents()` | Phase 1 |
| `src/engine/events.ts` | The `EngineEvent` relay wire vocabulary | KEEP from `tree-cli` |
| `src/permissions/{mode,modeGate,danger,protected}.ts` | The safe-by-default policy engine (mode/allowlist/remote/no-quarter) | KEEP/ADAPT from `tree-cli` |
| `src/permissions/classify.ts` | Pi `tool_call` `{toolName,input}` → `PermissionRequest` (new glue) | Phase 2 |
| `src/ext/permissionGate.ts` | `pi.on("tool_call")` gate: classify → policy → block; fail-closed; local `ctx.ui` + remote relay deciders; `tool_result` redaction | Phase 2 |

**Verify:** `npm test` (43 pure tests: policy + classify + fail-closed/routing) on
Node ≥ 22, plus two live smokes — `scripts/smoke-headless.ts` (Phase 1 adapter) and
`scripts/smoke-gate.ts` (Phase 2 gate blocks/permits a real `tool_call`).

## The one rule: boot before Pi

Two side effects **must** run before any `@earendil-works/pi-*` module loads:

1. `PI_CODING_AGENT_DIR = $PRIVATEER_HOME/agent` — Pi internals read `getAgentDir()`
   at import time and ignore the `agentDir` option, so the env var is the real lever.
2. The undici attestation dispatcher — Pi's extension hooks can't reach the TLS
   layer; a process-wide global dispatcher can, and captures the SPKI hash Tinfoil
   pins.

Entrypoints therefore do `import "./boot.ts";` and then **dynamically import** all
Pi-touching code. `boot.ts` imports only node builtins + our own paths/dispatcher —
never Pi. Keep it that way.

## Develop

**Requires Node ≥ 22.19.0.** This is a hard floor for the whole Pi stack, not
just the TUI: `pi-coding-agent`'s bundled undici calls `webidl.util.markAsUncloneable`,
which only exists on Node ≥ 22, so it throws at import on Node 20. `.nvmrc` pins it.

```sh
nvm use          # -> 22.19.0
npm install
npm run typecheck
npm start        # prints the resolved boot state (Phase 1 skeleton)
```

### Phase 1 live verify

Drives a real headless turn through boot → session → adapter and asserts the
`EngineEvent` stream shape. Needs an `OPENROUTER_API_KEY` in a gitignored `.env`:

```sh
PRIVATEER_HOME=./tests/fixtures node --env-file=.env --import tsx scripts/smoke-headless.ts
```

Two legs (text-only, tool-call) against `openrouter/openai/gpt-4o-mini`; asserts
`text/usage/finish` and `tool-call → tool-result` ordering. Verified 2026-07-07
against Pi 0.80.3 — the adapter's core event-name mappings match.
