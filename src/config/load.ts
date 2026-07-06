import { readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
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
  set(
    "google",
    "apiKey",
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
  );
  set("xai", "apiKey", process.env.XAI_API_KEY);
  set("groq", "apiKey", process.env.GROQ_API_KEY);
  set("mistral", "apiKey", process.env.MISTRAL_API_KEY);
  set("zai", "apiKey", process.env.ZAI_API_KEY ?? process.env.Z_AI_API_KEY);
  set("moonshot", "apiKey", process.env.MOONSHOT_API_KEY);
  set("cerebras", "apiKey", process.env.CEREBRAS_API_KEY);
  set("fireworks", "apiKey", process.env.FIREWORKS_API_KEY);
  set("deepseek", "apiKey", process.env.DEEPSEEK_API_KEY);
  set("minimax", "apiKey", process.env.MINIMAX_API_KEY);
  set("qwen", "apiKey", process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY);
  set("ollama", "baseURL", process.env.OLLAMA_BASE_URL);
  set("nearai", "apiKey", process.env.NEAR_AI_API_KEY ?? process.env.NEARAI_API_KEY);
  set("tinfoil", "apiKey", process.env.TINFOIL_API_KEY);
  set("venice", "apiKey", process.env.VENICE_API_KEY);
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

// Persist the global config (used by /model, /provider, /permissions to remember
// choices). The file holds provider API keys, so it is written owner-only (0600)
// inside an owner-only directory (0700). `chmod` is best-effort: it's a no-op on
// filesystems/platforms (e.g. Windows) that don't honour POSIX modes.
export function saveGlobalConfig(cfg: ConfigT): void {
  const g = globalPaths();
  mkdirSync(g.dir, { recursive: true });
  tryChmod(g.dir, 0o700);
  // `mode` on writeFileSync only applies when creating the file, so chmod after
  // to also tighten a pre-existing, looser config.
  writeFileSync(g.config, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  tryChmod(g.config, 0o600);
}

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* non-POSIX filesystem or insufficient perms — nothing we can do */
  }
}
