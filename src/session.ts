// Thin headless session wrapper (Phase 1).
//
// Wraps Pi's createAgentSession and exposes the ONE thing the preserved
// connection layer needs: a subscription that yields privateer EngineEvents
// (via the adapter) instead of raw Pi events. `createSession()` →
// `{ session, subscribeAsEngineEvents() }`, per docs/pi-migration-plan.md §2
// Phase 1. Mirrors the setup proven in ../../ pi-spike/spike-b.mjs.
//
// This module is Pi-touching: it is only ever loaded via a DYNAMIC import from
// an entrypoint that has already run ./boot.ts (env + dispatcher). Never import
// it statically from boot.ts or anything boot pulls in.

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
// From pi-ai, deliberately, not pi-coding-agent's `AuthStorage.inMemory()`. 0.84
// stopped exporting AuthStorage and our pi patch puts the export back — which is
// fine for the one caller that genuinely needs the file-backed store
// (providers/piAuthStore.ts) and wrong here, because patches are best-effort by
// design: `bin/apply-patches.mjs` degrades to stock pi when it cannot write to
// node_modules (the `sudo npm i -g` case it calls out). A static import of a
// patched-in export turns that graceful degradation into a hard ERR_IMPORT crash
// on every session start. pi-ai exports this store unpatched and it implements the
// same CredentialStore interface, so nothing about the session changes.
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

import { agentDir as defaultAgentDir } from "./config/paths.ts";
import { createEngineEventAdapter } from "./bridge/engineAdapter.ts";
import type { EngineEvent } from "./engine/events.ts";

export interface CreateSessionOptions {
  cwd: string;
  provider: string;
  modelId: string;
  // Pi extension factories, e.g. [makePermissionGate({ decide })].
  extensionFactories?: Array<(pi: any) => void>;
  // Custom tools (defineTool) plus the enabled tool-name allowlist.
  customTools?: unknown[];
  tools?: string[];
  // Override the Pi agent dir; defaults to $PRIVATEER_HOME/agent (pinned by boot).
  agentDir?: string;
}

export interface PrivateerSession {
  session: any;
  // Subscribe to the turn stream as privateer EngineEvents. Returns an unsubscribe.
  subscribeAsEngineEvents(onEvent: (ev: EngineEvent) => void): () => void;
  adapter: ReturnType<typeof createEngineEventAdapter>;
}

export async function createSession(opts: CreateSessionOptions): Promise<PrivateerSession> {
  const AGENT_DIR = opts.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? defaultAgentDir();

  // pi 0.84: ModelRegistry.create(authStorage, modelsPath) is gone. The registry is now
  // a synchronous facade over a ModelRuntime, and the runtime is what owns credentials —
  // so the store this session used to hand to the registry is injected into the runtime
  // instead. Still in-memory: a headless session must not touch the machine's auth.json.
  const authStorage = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials: authStorage,
    modelsPath: `${AGENT_DIR}/models.json`,
  });
  const modelRegistry = new ModelRegistry(modelRuntime);
  // Explicit, and awaited: find() below is synchronous, so models.json has to be loaded
  // before it runs or the lookup fails on a cold cache.
  await modelRegistry.refresh();

  const model = modelRegistry.find(opts.provider, opts.modelId);
  if (!model) {
    const ids = (modelRegistry.getAll() ?? []).map(
      (m: any) => `${m.provider}/${m.id}`,
    );
    throw new Error(
      `model ${opts.provider}/${opts.modelId} not found. Registry has: ${ids.join(", ") || "(none)"}`,
    );
  }

  const settingsManager = SettingsManager.create(opts.cwd, AGENT_DIR);
  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: AGENT_DIR,
    settingsManager,
    extensionFactories: opts.extensionFactories ?? [],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir: AGENT_DIR,
    model,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(opts.cwd),
    resourceLoader: loader,
    ...(opts.customTools ? { customTools: opts.customTools } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
  } as any);

  const adapter = createEngineEventAdapter();

  function subscribeAsEngineEvents(onEvent: (ev: EngineEvent) => void): () => void {
    const unsub = session.subscribe((ev: any) => {
      for (const ee of adapter.toEngineEvents(ev)) onEvent(ee);
    });
    return () => unsub?.();
  }

  return { session, subscribeAsEngineEvents, adapter };
}
