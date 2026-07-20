import { homedir } from "node:os";
import { join } from "node:path";

// Global config/data dir. Overridable via PRIVATEER_HOME (portability + tests).
// Computed lazily so the env var can be set before first use.
//
// KEEP — ported verbatim from tree-cli/src/config/paths.ts. This is the anchor
// the whole config layout hangs off, including Pi's agent dir (see boot.ts).
export function globalDir(): string {
  return process.env.PRIVATEER_HOME ?? join(homedir(), ".privateer");
}

// Pi's agent dir, nested UNDER the privateer home so there is one tree to
// back up / inspect / delete, and zero collision with a user's standalone Pi at
// ~/.pi/agent (we never read or write theirs). This is the value boot.ts pins
// into PI_CODING_AGENT_DIR before any Pi import.
//
//   ~/.privateer/                 ← PRIVATEER_HOME
//   ├── credentials.json          relay/account JWT (KEEP — privateer identity)
//   ├── config.json               webhooks/remote/posture prefs (ours; Pi never reads it)
//   ├── routines/
//   └── agent/                    ← PI_CODING_AGENT_DIR
//       ├── auth.json  models.json  settings.json  trust.json
//       ├── sessions/
//       └── extensions/
export function agentDir(): string {
  return join(globalDir(), "agent");
}

// Privateer-account session credentials (JWT access/refresh + user). Kept in a
// SEPARATE file from Pi's provider keys (agent/auth.json): these are session
// tokens with a different lifecycle (rotated on refresh, cleared on logout).
export function credentialsPath(): string {
  return join(globalDir(), "credentials.json");
}

// Privateer-only preferences read exclusively by our code (webhooks, remote
// access, posture, redaction). Pi never reads this file.
export function configPath(): string {
  return join(globalDir(), "config.json");
}

// Account-provider inference sessions this MACHINE has spawned, keyed by the pid of
// the terminal that owns each one (see auth/accountSessions.ts). Lets a launch tell a
// session belonging to a STILL-RUNNING terminal from one orphaned by a crash, so it
// can reclaim the orphan instead of spawning another and walking into the server's
// per-device terminal cap. Holds refresh tokens — written 0600, like credentials.json.
export function accountSessionsPath(): string {
  return join(globalDir(), "account-sessions.json");
}
