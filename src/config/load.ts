import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Config, type Config as ConfigT, type ProviderName } from "./schema.ts";
import { globalPaths, projectPaths, managedSettingsPath } from "./paths.ts";

// Back-compat re-exports: existing callers import these from here.
export { globalDir } from "./paths.ts";
export function globalConfigPath(): string {
  return globalPaths().config;
}
export function projectConfigPath(): string {
  return projectPaths().config;
}

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse config at ${path}: ${(err as Error).message}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Recursively merge raw config layers: objects merge per-key, everything else
// (scalars, arrays) is replaced by the higher-precedence layer.
function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

export interface ConfigLayer {
  label: string;
  path: string;
  present: boolean;
}

// The precedence chain, ordered low → high. Each scope contributes its
// config.json (credentials + prefs) then its settings file(s) on top; managed
// enterprise settings, if present, win over everything.
function layerSpecs(): { label: string; path: string }[] {
  const g = globalPaths();
  const p = projectPaths();
  const specs = [
    { label: "user config", path: g.config },
    { label: "user settings", path: g.settings },
    { label: "project config", path: p.config },
    { label: "project settings", path: p.settings },
    { label: "project settings (local)", path: p.settingsLocal },
  ];
  const managed = managedSettingsPath();
  if (managed) specs.push({ label: "managed", path: managed });
  return specs;
}

// Resolved layer presence, for `/doctor` and `/config`.
export function configLayers(): ConfigLayer[] {
  return layerSpecs().map(({ label, path }) => ({ label, path, present: existsSync(path) }));
}

// Environment fallbacks for provider credentials. Applied only when config omits them.
function applyEnv(cfg: ConfigT): ConfigT {
  const p = cfg.providers;
  const set = (name: ProviderName, key: "apiKey" | "baseURL", val?: string) => {
    if (!val) return;
    p[name] = { ...(p[name] ?? {}), [key]: (p[name] as any)?.[key] ?? val };
  };
  set("openrouter", "apiKey", process.env.OPENROUTER_API_KEY);
  set("anthropic", "apiKey", process.env.ANTHROPIC_API_KEY);
  set("openai", "apiKey", process.env.OPENAI_API_KEY);
  set("ollama", "baseURL", process.env.OLLAMA_BASE_URL);
  return cfg;
}

export function loadConfig(): ConfigT {
  // Merge raw layers first (so per-layer files stay partial), then parse once so
  // schema defaults are applied to the resolved object rather than each layer.
  let raw: unknown = {};
  for (const { path } of layerSpecs()) {
    raw = deepMerge(raw, readJsonIfExists(path));
  }
  const cfg = Config.parse(raw ?? {});
  return applyEnv(cfg);
}

// Persist the global config (used by /model, /provider, /permissions to remember choices).
export function saveGlobalConfig(cfg: ConfigT): void {
  const g = globalPaths();
  mkdirSync(g.dir, { recursive: true });
  writeFileSync(g.config, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}
