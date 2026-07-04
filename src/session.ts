import type { LanguageModel, ToolSet } from "ai";
import type { Config } from "./config/schema.ts";
import { resolveModel, parseModelSpec } from "./providers/resolve.ts";
import { modelSupports, modalitiesFor, suggestModelFor } from "./providers/capabilities.ts";
import type { Route, RouteSet, Modality } from "./engine/router.ts";
import { createTools, createReadOnlyTools, createToolSubset } from "./tools/index.ts";
import { buildSystemPrompt, buildSubAgentPrompt, buildAgentPrompt } from "./context/systemPrompt.ts";
import { findOutputStyle } from "./context/outputStyles.ts";
import { QueryEngine } from "./engine/QueryEngine.ts";
import { autoApproveGate, type PermissionGate } from "./permissions/gate.ts";
import type { SubAgentRunner } from "./tools/context.ts";
import type { UserAsker } from "./tools/askUser.ts";
import { TodoStore } from "./tools/todoStore.ts";
import type { CheckpointStore } from "./memory/checkpoints.ts";
import type { ProcessRegistry } from "./tools/processRegistry.ts";
import { AttachmentStore } from "./util/attachmentStore.ts";
import { HookRunner, loadHooks, wrapToolsWithHooks } from "./hooks/engine.ts";
import { createLimiter } from "./util/limit.ts";

export interface SessionOptions {
  config: Config;
  modelSpec: string;
  cwd: string;
  gate?: PermissionGate;
  // Confine file tools to cwd (default true). False lets the agent read/edit anywhere.
  confineToCwd?: boolean;
  // Out-of-cwd directories approved this session; shared with the gate so an approved
  // location stops re-prompting. Pass the same array instance the gate holds.
  allowedOutsideRoots?: string[];
  // Active output style name (persona); resolved against .privateer/output-styles.
  outputStyle?: string;
  // When true, the system prompt instructs the model to plan, not implement.
  planMode?: boolean;
  // Session checkpoint store; write/edit record mutations into it for /rewind.
  checkpoints?: CheckpointStore;
  // Extra tools merged into the toolset (e.g. tools exposed by MCP servers).
  extraTools?: ToolSet;
  // When set, restrict the built-in toolset to these tool names (MCP `extraTools`
  // are always kept). Used for unattended runs (scheduled routines) that must not
  // have write/bash/edit auto-approved with no human to gate them.
  allowedTools?: string[];
  // Background-shell registry for bash run_in_background / bash_output / kill_shell.
  processes?: ProcessRegistry;
  // Session attachment store, so dragged/pasted file bytes can be saved via the
  // save_attachment tool. Created here when the caller doesn't supply one.
  attachments?: AttachmentStore;
  // Reports each finished `task` sub-agent's run metrics (tool uses + tokens) by
  // tool-call id, so the TUI can render the grouped agents view. Best-effort.
  onSubAgentMetrics?: (toolCallId: string, m: { toolUses: number; tokens: number }) => void;
  // Surfaces an `ask_user` question to the live TUI and resolves with the choice.
  // Omitted outside the interactive app, where ask_user reports it couldn't ask.
  askUser?: UserAsker;
  // Streams a file to the connected remote controller (Privateer app), for the
  // send_file_to_client tool. Omitted when remote access isn't available.
  sendFileToController?: (file: {
    name: string;
    mediaType: string;
    base64: string;
    size: number;
  }) => Promise<{ ok: boolean; reason?: string }>;
}

export interface Session {
  engine: QueryEngine;
  modelSpec: string;
  provider: string;
  modelId: string;
  cwd: string;
  todos: TodoStore;
  attachments: AttachmentStore;
}

// Assemble a ready-to-run agent session: resolve the model, bind tools to the
// cwd + permission gate, build the system prompt, and create the engine.
export function createSession(opts: SessionOptions): Session {
  const resolved = resolveModel(opts.modelSpec, opts.config);
  const gate = opts.gate ?? autoApproveGate;
  const confineToCwd = opts.confineToCwd ?? true;
  const allowedOutsideRoots = opts.allowedOutsideRoots ?? [];
  const todos = new TodoStore();
  const attachments = opts.attachments ?? new AttachmentStore();
  const cache = isAnthropicFamily(resolved.provider, resolved.modelId);

  // Bound how many sub-agents run at once when the model fans `task` calls out.
  const subAgentLimit = createLimiter(opts.config.maxSubagents);

  // A `task` sub-agent: a fresh engine run to completion, returning the text it
  // produced. Without an agent definition it uses the read-only toolset under an
  // auto-approve gate; with one it uses that agent's tools (routed through the parent
  // gate, so any mutations are still user-approved), model override, and instructions.
  const runSubAgent: SubAgentRunner = ({ description, prompt, agent }) =>
    subAgentLimit(async () => {
    let model = resolved.model;
    let childCache = cache;
    if (agent?.model) {
      try {
        const r = resolveModel(agent.model, opts.config);
        model = r.model;
        childCache = isAnthropicFamily(r.provider, r.modelId);
      } catch {
        /* fall back to the parent model */
      }
    }
    const system = agent
      ? buildAgentPrompt({ cwd: opts.cwd, model: opts.modelSpec, description, instructions: agent.prompt })
      : buildSubAgentPrompt({ cwd: opts.cwd, model: opts.modelSpec, description });
    const tools = agent
      ? createToolSubset({ cwd: opts.cwd, gate, confineToCwd, allowedOutsideRoots }, agent.tools)
      : createReadOnlyTools({ cwd: opts.cwd, gate: autoApproveGate, confineToCwd, allowedOutsideRoots });

    const child = new QueryEngine({
      routes: singleRouteSet(agent?.model ?? opts.modelSpec, model, childCache),
      system,
      tools,
      maxSteps: Math.min(opts.config.maxSteps, 20),
    });
    let out = "";
    let toolUses = 0;
    for await (const ev of child.send(prompt)) {
      if (ev.type === "text") out += ev.text;
      else if (ev.type === "tool-call") toolUses++;
      else if (ev.type === "error")
        return { text: `Sub-agent error: ${ev.error}`, toolUses, tokens: child.usage.totalTokens };
    }
    return {
      text: out.trim() || "(sub-agent returned no output)",
      toolUses,
      tokens: child.usage.totalTokens,
    };
    });

  const hooks = new HookRunner(loadHooks((opts.config as Record<string, unknown>).hooks), opts.cwd);
  let builtinTools = createTools({
    cwd: opts.cwd,
    gate,
    confineToCwd,
    allowedOutsideRoots,
    todos,
    runSubAgent,
    onSubAgentMetrics: opts.onSubAgentMetrics,
    recordMutation: opts.checkpoints ? (abs) => opts.checkpoints!.recordMutation(abs) : undefined,
    processes: opts.processes,
    attachments,
    askUser: opts.askUser,
    sendFileToController: opts.sendFileToController,
  });
  if (opts.allowedTools) {
    const allow = new Set(opts.allowedTools);
    builtinTools = Object.fromEntries(
      Object.entries(builtinTools).filter(([name]) => allow.has(name)),
    );
  }
  const tools = wrapToolsWithHooks(
    {
      ...builtinTools,
      ...(opts.extraTools ?? {}),
    },
    hooks,
  );
  const outputStyleBody = opts.outputStyle
    ? findOutputStyle(opts.outputStyle, opts.cwd)?.body
    : undefined;
  const system = buildSystemPrompt({
    cwd: opts.cwd,
    model: opts.modelSpec,
    outputStyleBody,
    planMode: opts.planMode,
  });

  const engine = new QueryEngine({
    routes: buildRouteSet(opts.config, opts.modelSpec, resolved.model, cache),
    system,
    tools,
    maxSteps: opts.config.maxSteps,
    contextBudget: opts.config.contextBudget,
    compactRatio: opts.config.compactRatio,
  });

  return {
    engine,
    modelSpec: opts.modelSpec,
    provider: resolved.provider,
    modelId: resolved.modelId,
    cwd: opts.cwd,
    todos,
    attachments,
  };
}

// Anthropic prompt caching only benefits Anthropic-family models: direct Anthropic,
// or an OpenRouter route to an Anthropic model. For everything else the cache hints
// are a harmless no-op, but we skip them to avoid sending unused providerOptions.
function isAnthropicFamily(provider: string, modelId: string): boolean {
  if (provider === "anthropic") return true;
  if (provider === "openrouter") return modelId.startsWith("anthropic/");
  return false;
}

// Short display name for UI notices: drop any "vendor/" prefix from the model id.
function shortLabel(spec: string): string {
  const modelId = spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec;
  return modelId.slice(modelId.lastIndexOf("/") + 1);
}

// Resolve a "provider:model" spec into a Route, deriving its per-model cache /
// thinking flags and supported input modalities from the model family.
function buildRoute(spec: string, config: Config): Route {
  const r = resolveModel(spec, config);
  const cache = isAnthropicFamily(r.provider, r.modelId);
  return {
    spec,
    model: r.model,
    cacheControl: cache,
    thinkingBudget: cache ? config.thinkingBudget : undefined,
    label: shortLabel(spec),
    supports: modalitiesFor(r.provider, r.modelId),
  };
}

// A trivial RouteSet with only the default route (sub-agents, which run one fixed
// model). The high `longThreshold` / zero `fastMaxChars` keep the router on default.
function singleRouteSet(spec: string, model: LanguageModel, cacheControl: boolean): RouteSet {
  const { provider, modelId } = parseModelSpec(spec);
  return {
    default: { spec, model, cacheControl, label: shortLabel(spec), supports: modalitiesFor(provider, modelId) },
    longThreshold: Number.POSITIVE_INFINITY,
    fastMaxChars: 0,
  };
}

// Pairs of (config key, RouteSet key, modality) for the modality routes.
const MODALITY_ROUTE_KEYS: { cfg: "vision" | "document" | "audio" | "video"; modality: Modality }[] = [
  { cfg: "vision", modality: "image" },
  { cfg: "document", modality: "document" },
  { cfg: "audio", modality: "audio" },
  { cfg: "video", modality: "video" },
];

// Assemble the session's RouteSet: the default route (the already-resolved session
// model) plus any configured modality/long/fast routes, each tagged with the input
// modalities its model accepts. Optional routes that fail to resolve are skipped
// rather than failing the session. For each modality whose route is unset, hybrid
// auto-detect picks a capable model when the default can't handle that modality.
function buildRouteSet(
  config: Config,
  defaultSpec: string,
  defaultModel: LanguageModel,
  defaultCache: boolean,
): RouteSet {
  const router = config.router;
  const tryRoute = (spec?: string): Route | undefined => {
    if (!spec) return undefined;
    try {
      return buildRoute(spec, config);
    } catch {
      return undefined; // unconfigured/invalid optional route → ignored
    }
  };

  const { provider: defProvider, modelId: defModelId } = parseModelSpec(defaultSpec);
  const routes: RouteSet = {
    default: {
      spec: defaultSpec,
      model: defaultModel,
      cacheControl: defaultCache,
      thinkingBudget: defaultCache ? config.thinkingBudget : undefined,
      label: shortLabel(defaultSpec),
      supports: modalitiesFor(defProvider, defModelId),
    },
    vision: tryRoute(router?.vision),
    document: tryRoute(router?.document),
    audio: tryRoute(router?.audio),
    video: tryRoute(router?.video),
    long: tryRoute(router?.long),
    fast: tryRoute(router?.fast),
    longThreshold: router?.longThreshold ?? Math.floor((config.contextBudget ?? 120_000) / 2),
    fastMaxChars: router?.fastMaxChars ?? 280,
  };

  if (router?.auto ?? true) {
    for (const { cfg, modality } of MODALITY_ROUTE_KEYS) {
      if (routes[cfg]) continue; // explicitly configured → leave it
      if (modelSupports(modality, defProvider, defModelId)) continue; // default handles it
      const suggestion = suggestModelFor(modality, config);
      if (suggestion) routes[cfg] = tryRoute(suggestion);
    }
  }
  return routes;
}
