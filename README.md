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

## Status — Phase 1 skeleton

Scaffold + the two load-bearing seams promoted from the de-risking spike
(`../pi-spike`, both risks spike-verified 2026-07-07):

| Module | Role | Source |
|---|---|---|
| `src/boot.ts` | Pins `PI_CODING_AGENT_DIR` + installs the attestation dispatcher **before any Pi import** | new (the ordering contract) |
| `src/attest/dispatcher.ts` | Out-of-band undici global dispatcher; captures enclave TLS SPKI hash | `pi-spike/spike-a.mjs` |
| `src/bridge/engineAdapter.ts` | Pi `session.subscribe` events → privateer `EngineEvent`s | `pi-spike/adapter.mjs` |
| `src/ext/permissionGate.ts` | `pi.on("tool_call")` gate, fail-closed, local + remote deciders | `pi-spike/spike-b.mjs` |
| `src/session.ts` | Thin headless session wrapper → `subscribeAsEngineEvents()` | Phase 1 |
| `src/engine/events.ts` | The `EngineEvent` relay wire vocabulary | KEEP from `tree-cli` |

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

```sh
npm install
npm run typecheck
npm start        # prints the resolved boot state (Phase 1 skeleton)
```

Requires Node ≥ 20.
