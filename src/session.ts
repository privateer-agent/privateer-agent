import type { Config } from "./config/schema.ts";
import { resolveModel } from "./providers/resolve.ts";
import { createTools, createReadOnlyTools } from "./tools/index.ts";
import { buildSystemPrompt, buildSubAgentPrompt } from "./context/systemPrompt.ts";
import { findOutputStyle } from "./context/outputStyles.ts";
import { QueryEngine } from "./engine/QueryEngine.ts";
import { autoApproveGate, type PermissionGate } from "./permissions/gate.ts";
import type { SubAgentRunner } from "./tools/context.ts";
import { TodoStore } from "./tools/todoStore.ts";

export interface SessionOptions {
  config: Config;
  modelSpec: string;
  cwd: string;
  gate?: PermissionGate;
  // Active output style name (persona); resolved against .privateer/output-styles.
  outputStyle?: string;
  // When true, the system prompt instructs the model to plan, not implement.
  planMode?: boolean;
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

  // A `task` sub-agent: a fresh engine with the read-only toolset, run to completion,
  // returning the text it produced. Capped at a lower step budget than the parent.
  const runSubAgent: SubAgentRunner = async ({ description, prompt }) => {
    const child = new QueryEngine({
      model: resolved.model,
      system: buildSubAgentPrompt({ cwd: opts.cwd, model: opts.modelSpec, description }),
      tools: createReadOnlyTools({ cwd: opts.cwd, gate: autoApproveGate }),
      maxSteps: Math.min(opts.config.maxSteps, 20),
      cacheControl: cache,
    });
    let out = "";
    for await (const ev of child.send(prompt)) {
      if (ev.type === "text") out += ev.text;
      else if (ev.type === "error") return `Sub-agent error: ${ev.error}`;
    }
    return out.trim() || "(sub-agent returned no output)";
  };

  const tools = createTools({ cwd: opts.cwd, gate, todos, runSubAgent });
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
