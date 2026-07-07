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
  AuthStorage,
} from "@earendil-works/pi-coding-agent";

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

  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.create(authStorage, `${AGENT_DIR}/models.json`);
  if (typeof (modelRegistry as any).refresh === "function") await (modelRegistry as any).refresh();
  else if (typeof (modelRegistry as any).loadModels === "function")
    await (modelRegistry as any).loadModels();

  const model = modelRegistry.find(opts.provider, opts.modelId);
  if (!model) {
    const ids = ((modelRegistry as any).getAll?.() ?? []).map(
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
    authStorage,
    modelRegistry,
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
