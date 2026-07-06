import { z } from "zod";
import { DEFAULT_DENYLIST } from "../permissions/danger.ts";

// A provider's credentials/endpoint. All fields optional so config can be sparse
// and filled in from environment variables at load time.
export const ProviderConfig = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  // OpenRouter only: when true, every request is pinned to a Zero-Data-Retention
  // endpoint (provider.zdr) so prompts can't be retained. Models without a ZDR
  // endpoint then become unusable (and render red in the picker). Ignored by
  // other providers.
  enforceZdr: z.boolean().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const PERMISSION_MODES = ["default", "acceptEdits", "bypass", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const Config = z.object({
  // "provider:model", e.g. "openrouter:anthropic/claude-opus-4.8".
  defaultModel: z.string().default("anthropic:claude-opus-4-8"),
  permissionMode: z.enum(PERMISSION_MODES).default("acceptEdits"),
  providers: z
    .object({
      openrouter: ProviderConfig.optional(),
      anthropic: ProviderConfig.optional(),
      openai: ProviderConfig.optional(),
      google: ProviderConfig.optional(),
      xai: ProviderConfig.optional(),
      groq: ProviderConfig.optional(),
      ollama: ProviderConfig.optional(),
      nearai: ProviderConfig.optional(),
      tinfoil: ProviderConfig.optional(),
      // Custom OpenAI-compatible endpoint (LM Studio, vLLM, llama.cpp, a corporate
      // proxy, …): the user supplies baseURL (required) and apiKey (optional).
      custom: ProviderConfig.optional(),
      // Privateer account: inference billed to the user's account, no API key.
      // Auth lives in ~/.privateer/credentials.json (see src/auth/privateer.ts),
      // not here; this entry only carries an optional server baseURL override.
      privateer: ProviderConfig.optional(),
    })
    .default({}),
  // Confine file access to the working directory. When true (the default), the agent
  // reads/searches/edits only within cwd; reaching outside (an absolute path or `../`
  // escape) requires explicit per-location approval. Set false to let it roam freely.
  confineToCwd: z.boolean().default(true),
  // Bash command prefixes that are auto-approved (e.g. "git status", "ls").
  allowlist: z.array(z.string()).default([]),
  // Regex sources for commands that ALWAYS require confirmation, even under
  // bypass or an allowlist entry (destructive/exfil shapes). Extend per-project.
  denylist: z.array(z.string()).default(DEFAULT_DENYLIST),
  // Hard cap on agent tool-loop steps per turn.
  maxSteps: z.number().int().positive().default(50),
  // Approx token budget for the conversation context (used to trigger auto-compaction).
  contextBudget: z.number().int().positive().default(120_000),
  // Fraction of contextBudget at which to auto-compact older history (0–1).
  compactRatio: z.number().positive().max(1).default(0.8),
  // Modal (vim) editing in the prompt input.
  vim: z.boolean().default(false),
  // Active output style (persona) by name; loaded from .privateer/output-styles.
  outputStyle: z.string().optional(),
  // Max `task` sub-agents allowed to run concurrently when the model fans them out.
  maxSubagents: z.number().int().positive().default(4),
  // Anthropic extended-thinking budget in tokens (opt-in; Anthropic models only).
  thinkingBudget: z.number().int().positive().optional(),
  // Per-turn model routing. The `default` route is `defaultModel` above; these are
  // the specialized routes the router switches to based on the turn's data/shape.
  // See src/engine/router.ts for the selection rules (vision > long > fast > default).
  router: z
    .object({
      // Per-modality routes — turns whose input includes that kind go to this model.
      vision: z.string().optional(), // image input
      document: z.string().optional(), // PDF / document input
      audio: z.string().optional(), // audio input
      video: z.string().optional(), // video input
      long: z.string().optional(), // large conversations
      fast: z.string().optional(), // short, cheap turns
      // Estimated-token threshold that triggers the `long` route. Defaults to half
      // the contextBudget when unset (resolved in the session, not here).
      longThreshold: z.number().int().positive().optional(),
      // Prompts at or below this many characters are eligible for the `fast` route.
      fastMaxChars: z.number().int().positive().default(280),
      // Referenced text/code files at or below this many bytes are inlined into the
      // prompt (read-as-text); larger ones are left as a path for the read tool.
      inlineTextMaxBytes: z.number().int().positive().default(65_536),
      // Hybrid auto-detect: when a modality route is unset and the default model can't
      // handle that modality, pick a capable model automatically.
      auto: z.boolean().default(true),
    })
    .optional(),
  // Shell command whose stdout becomes the status line; receives session JSON on stdin.
  statusLine: z.string().optional(),
})
  // Preserve unknown keys so layered settings files can carry forward-compatible
  // sections (hooks, mcpServers, statusLine, …) before they have explicit schemas.
  .catchall(z.unknown());
export type Config = z.infer<typeof Config>;

export const KNOWN_PROVIDERS = [
  "openrouter",
  "anthropic",
  "openai",
  "google",
  "xai",
  "groq",
  "ollama",
  "nearai",
  "tinfoil",
  "custom",
  "privateer",
] as const;
export type ProviderName = (typeof KNOWN_PROVIDERS)[number];
