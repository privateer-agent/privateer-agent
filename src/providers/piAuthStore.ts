// Access to Pi's credential store and model registry after the 0.84 refactor.
//
// pi-coding-agent 0.84 folded credential storage and the model registry into a single
// `ModelRuntime` and removed both from `AgentSessionServices`. Two things that used to
// hang off `services` no longer do:
//
//   services.authStorage   -> gone; the runtime owns a private CredentialStore
//   services.modelRegistry -> gone; superseded by services.modelRuntime
//
// This module is the single place that knows about that change, so the account channel
// and the entrypoints don't each grow their own workaround.
//
// ⚠️ NOTHING HERE MAY STATICALLY IMPORT PI. This module is pulled in by
// providers/account.ts, which is itself statically imported by extensions and by the
// harbor — and whose static graph is deliberately Pi-free, because Pi must not load
// before boot.ts has installed the env and the dispatcher (the same contract session.ts
// documents). So the one place a Pi class is genuinely needed loads it dynamically, and
// everything else is duck-typed off objects Pi already handed us.

import { join } from "node:path";

import { agentDir as defaultAgentDir } from "../config/paths.ts";

/** The agent dir Pi is actually using — boot pins PI_CODING_AGENT_DIR to ours. */
function resolveAgentDir(agentDir?: string): string {
  return agentDir ?? process.env.PI_CODING_AGENT_DIR ?? defaultAgentDir();
}

/** The subset of Pi's CredentialStore the account channel uses. All async in 0.84. */
export type PiCredentialStore = {
  read(providerId: string): Promise<unknown>;
  modify(providerId: string, fn: (current: unknown) => Promise<unknown>): Promise<unknown>;
  delete(providerId: string): Promise<void>;
};

let cached: { path: string; store: Promise<PiCredentialStore> } | undefined;
let override: Promise<PiCredentialStore> | undefined;

/**
 * Pi's credential store for auth.json — the same file, format and class the ModelRuntime
 * uses. `AuthStorage` IS that class: model-runtime.js defaults to
 * `DefaultAuthStorage.create(authPath)`, where DefaultAuthStorage is this exact export,
 * and it already implements the public CredentialStore interface. 0.84 merely stopped
 * re-exporting it, so our pi patch puts the export back — which keeps us on Pi's own
 * store and file format instead of reimplementing either.
 *
 * Why ModelRuntime isn't enough: it exposes login/logout/listCredentials but no way to
 * WRITE an OAuth credential, and pi-ai exports only InMemoryCredentialStore. The account
 * channel must write one, because Pi persists an OAuth credential only for a login IT
 * drove — never for our device-code flow.
 *
 * Holding a second instance over the same path is safe and is not a shortcut: auth.json
 * is machine-global and shared by every terminal on the box, so the store is already
 * built for concurrent access (per-path shared read state, a file-revision check on
 * read, serialized `modify` writes). A second instance in this process is just one more
 * reader/writer, exactly like another terminal — which is the case the ownership check
 * in account.ts exists to handle.
 */
export function piAuthStore(agentDir?: string): Promise<PiCredentialStore> {
  if (override) return override;
  const path = join(resolveAgentDir(agentDir), "auth.json");
  if (cached?.path !== path) {
    cached = {
      path,
      store: import("@earendil-works/pi-coding-agent").then(
        (pi) => (pi as { AuthStorage: { create(p: string): PiCredentialStore } }).AuthStorage.create(path),
      ),
    };
  }
  return cached.store;
}

/**
 * Substitute the store. Tests only.
 *
 * The account channel's ownership rules used to be testable by handing the functions a
 * ctx with a fake store on it; the store is resolved internally now, so this is the seam
 * that replaces it. Pass undefined to restore the real one.
 */
export function setPiAuthStoreForTests(store: PiCredentialStore | undefined): void {
  override = store ? Promise.resolve(store) : undefined;
  cached = undefined;
}

/** The registry-shaped reads our callers make. Matches the old ModelRegistry facade. */
export type RegistryLike = {
  find(provider: string, modelId: string): unknown;
  getAll(): readonly unknown[];
  getAvailable(): Promise<readonly unknown[]>;
};

/**
 * A registry-shaped view of a session's services.
 *
 * 0.84 kept `ModelRegistry` as a synchronous facade over `ModelRuntime` (that is how
 * extensions still see it) but stopped putting one on `services`. We deliberately do NOT
 * construct one: importing the class would drag Pi into this module's static graph. The
 * runtime is a live object Pi already gave us, so three delegating methods reproduce
 * exactly the surface our callers used — `find` is `getModel` renamed.
 */
export function modelRegistryOf(services: { modelRuntime?: unknown } | null | undefined): RegistryLike {
  const runtime = services?.modelRuntime as {
    getModel(p: string, id: string): unknown;
    getModels(): readonly unknown[];
    getAvailable(): Promise<readonly unknown[]>;
  } | undefined;
  return {
    find: (provider, modelId) => runtime?.getModel(provider, modelId),
    getAll: () => runtime?.getModels() ?? [],
    getAvailable: async () => (await runtime?.getAvailable()) ?? [],
  };
}
