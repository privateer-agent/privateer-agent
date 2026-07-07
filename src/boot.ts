// BOOT — the first module loaded, before any Pi module exists in the graph.
//
// Two load-bearing side effects, both of which MUST happen before Pi is
// imported/evaluated (see docs/pi-migration-plan.md §0 and §Appendix A.3):
//
//   1. Pin PI_CODING_AGENT_DIR to $PRIVATEER_HOME/agent. Many Pi internals
//      (settings-manager, auth-storage, model-registry, migrations, sdk) call
//      getAgentDir() directly at import/eval time and IGNORE the agentDir option,
//      so the env var — not the option — is the real lever. Set it here, once.
//
//   2. Install the process-wide undici attestation dispatcher, so Pi's provider
//      TLS handshakes flow through a connector we can inspect (the TEE/Tinfoil
//      SPKI capture). Pi's extension hooks can't reach the TLS layer; this can.
//
// ORDERING CONTRACT: this module imports ONLY node builtins + our own paths and
// dispatcher modules. It must NEVER import anything from @earendil-works/pi-*.
// Entrypoints do `import "./boot.ts";` and then DYNAMICALLY import all
// Pi-touching code, so these side effects are guaranteed to run first regardless
// of ESM hoisting. Keep this file dependency-light and import-order-safe.

import { agentDir } from "./config/paths.ts";
// The attestation dispatcher now lives in the pi-privacy package (the publishable
// moat). boot still installs it pre-Pi as belt-and-suspenders; the package's
// extension would also install it at extension-init (idempotent — same module
// instance, so the captured-cert map is shared).
import { installAttestationDispatcher } from "pi-privacy/attest";

// (1) Pin Pi's agent dir under the privateer home. `??=` so an explicit
// PI_CODING_AGENT_DIR from the environment still wins (tests, power users).
//
// NOTE: confirm the literal env var name against the installed Pi constant —
// ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`, which is
// "PI_CODING_AGENT_DIR" for APP_NAME="pi". Pinned here as a constant so a Pi
// rename surfaces as one edit, not a silent config-home split.
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
process.env[PI_AGENT_DIR_ENV] ??= agentDir();

// (2) Install the attestation dispatcher (idempotent).
installAttestationDispatcher();

// Marker other modules can assert on to catch an accidental "imported Pi before
// boot" regression during development.
export const BOOTED = true;
