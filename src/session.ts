import type { ToolSet } from "ai";
import type { Config } from "./config/schema.ts";
import { resolveModel } from "./providers/resolve.ts";
import { createTools, createReadOnlyTools, createToolSubset } from "./tools/index.ts";
import { buildSystemPrompt, buildSubAgentPrompt, buildAgentPrompt } from "./context/systemPrompt.ts";
import { findOutputStyle } from "./context/outputStyles.ts";
import { QueryEngine } from "./engine/QueryEngine.ts";
import { autoApproveGate, type PermissionGate } from "./permissions/gate.ts";
import type { SubAgentRunner } from "./tools/context.ts";
import { TodoStore } from "./tools/todoStore.ts";
import type { CheckpointStore } from "./memory/checkpoints.ts";
import type { ProcessRegistry } from "./tools/processRegistry.ts";
import { HookRunner, loadHooks, wrapToolsWithHooks } from "./hooks/engine.ts";
import { createLimiter } from "./util/limit.ts";

export interface SessionOptions {
  config: Config;
  modelSpec: string;
  cwd: string;
  gate?: PermissionGate;
  // Active output style name (persona); resolved against .privateer/output-styles.
  outputStyle?: string;
  // When true, the system prompt instructs the model to plan, not implement.
  planMode?: boolean;
  // Session checkpoint store; write/edit record mutations into it for /rewind.
  checkpoints?: CheckpointStore;
  // Extra tools merged into the toolset (e.g. tools exposed by MCP servers).
  extraTools?: ToolSet;
  // Background-shell registry for bash run_in_background / bash_output / kill_shell.
  processes?: ProcessRegistry;
}

export interface Session {
  engine: QueryEngine;
  modelSpec: string;
  provider: string;
  modelId: string;
  cwd: string;
  todos: TodoStore;
}

// Assemble a ready-to-run agent session: resolve the model, bind tools to the
// cwd + permission gate, build the system prompt, and create the engine.
export function createSession(opts: SessionOptions): Session {
  const resolved = resolveModel(opts.modelSpec, opts.config);
  const gate = opts.gate ?? autoApproveGate;
  const todos = new TodoStore();
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
      ? createToolSubset({ cwd: opts.cwd, gate }, agent.tools)
      : createReadOnlyTools({ cwd: opts.cwd, gate: autoApproveGate });

    const child = new QueryEngine({
      model,
      system,
      tools,
      maxSteps: Math.min(opts.config.maxSteps, 20),
      cacheControl: childCache,
    });
    let out = "";
    for await (const ev of child.send(prompt)) {
      if (ev.type === "text") out += ev.text;
      else if (ev.type === "error") return `Sub-agent error: ${ev.error}`;
    }
    return out.trim() || "(sub-agent returned no output)";
    });

  const hooks = new HookRunner(loadHooks((opts.config as Record<string, unknown>).hooks), opts.cwd);
  const tools = wrapToolsWithHooks(
    {
      ...createTools({
        cwd: opts.cwd,
        gate,
        todos,
        runSubAgent,
        recordMutation: opts.checkpoints ? (abs) => opts.checkpoints!.recordMutation(abs) : undefined,
        processes: opts.processes,
      }),
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
    model: resolved.model,
    system,
    tools,
    maxSteps: opts.config.maxSteps,
    cacheControl: cache,
    contextBudget: opts.config.contextBudget,
    compactRatio: opts.config.compactRatio,
    // Extended thinking is Anthropic-only; pass the budget only for that family.
    thinkingBudget: cache ? opts.config.thinkingBudget : undefined,
  });

  return {
    engine,
    modelSpec: opts.modelSpec,
    provider: resolved.provider,
    modelId: resolved.modelId,
    cwd: opts.cwd,
    todos,
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
