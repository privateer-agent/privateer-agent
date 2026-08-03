import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "../config/paths.ts";
import { providersToGenerate, type ProviderEntry } from "./catalog.ts";

// Emit models.json entries for the config-only providers Pi doesn't ship and
// pi-privacy doesn't register (today: just `qwen`). Built-ins come from pi-ai's
// static catalogs; privacy providers from the pi-privacy extension; the privateer
// account channel from code. See catalog.ts for the full accounting.
//
// Model metadata defaults follow the migration plan Appendix A.4 (used until a live
// listing refines them): contextWindow 128000, maxTokens 16384, zero cost, text-only.

export interface ModelsJsonModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
}

export interface ModelsJsonProvider {
  name: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models: ModelsJsonModel[];
}

export interface ModelsJson {
  providers: Record<string, ModelsJsonProvider>;
}

// Per-id context-window overrides for seeds whose real window is far from the
// Appendix A.4 default (kept until the live listing refines them). Qwen3.8-Max
// serves ~1M tokens (983,616 advertised at launch, 2026-08-03).
const SEED_CONTEXT: Record<string, number> = {
  "qwen3.8-max-preview": 1_000_000,
};

function seedModel(id: string, compat?: Record<string, unknown>): ModelsJsonModel {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: SEED_CONTEXT[id] ?? 128000,
    maxTokens: 16384,
    ...(compat ? { compat } : {}),
  };
}

function providerConfig(p: ProviderEntry): ModelsJsonProvider {
  return {
    name: p.id,
    baseUrl: p.baseUrl!,
    api: p.api ?? "openai-completions",
    // Env-template key (Pi resolves ${...}; auth.json takes precedence when present).
    // Never a literal key — and never emitted for the account/venice providers.
    ...(p.keyEnv ? { apiKey: p.keyEnv, authHeader: true } : {}),
    ...(p.compat ? { compat: p.compat } : {}),
    models: (p.seedModels ?? []).map((id) => seedModel(id, p.compat)),
  };
}

// Build the models.json object for all `generate`-sourced providers.
export function generateModelsJson(providers: ProviderEntry[] = providersToGenerate()): ModelsJson {
  const out: ModelsJson = { providers: {} };
  for (const p of providers) {
    if (p.source !== "generate" || !p.baseUrl) continue;
    out.providers[p.id] = providerConfig(p);
  }
  return out;
}

// Merge generated providers into an existing models.json WITHOUT clobbering
// user-added or extension-registered providers. Generated ids are refreshed; every
// other provider in the file is preserved. Writes to $PRIVATEER_HOME/agent/models.json
// by default. Returns the merged object.
export function writeModelsJson(
  generated: ModelsJson = generateModelsJson(),
  path: string = join(agentDir(), "models.json"),
): ModelsJson {
  let existing: ModelsJson = { providers: {} };
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.providers) existing = parsed;
    } catch {
      // Unreadable/corrupt file → treat as empty rather than throwing; we only add
      // our generated providers and never drop the user's.
    }
  }
  const merged: ModelsJson = { providers: { ...existing.providers, ...generated.providers } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return merged;
}
