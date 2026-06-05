import { z } from "zod";

// A provider's credentials/endpoint. All fields optional so config can be sparse
// and filled in from environment variables at load time.
export const ProviderConfig = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const PERMISSION_MODES = ["default", "acceptEdits", "bypass", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const Config = z.object({
  // "provider:model", e.g. "openrouter:anthropic/claude-opus-4.8".
  defaultModel: z.string().default("anthropic:claude-opus-4-8"),
  permissionMode: z.enum(PERMISSION_MODES).default("default"),
  providers: z
    .object({
      openrouter: ProviderConfig.optional(),
      anthropic: ProviderConfig.optional(),
      openai: ProviderConfig.optional(),
      ollama: ProviderConfig.optional(),
    })
    .default({}),
  // Bash command prefixes that are auto-approved (e.g. "git status", "ls").
  allowlist: z.array(z.string()).default([]),
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
  // Shell command whose stdout becomes the status line; receives session JSON on stdin.
  statusLine: z.string().optional(),
})
  // Preserve unknown keys so layered settings files can carry forward-compatible
  // sections (hooks, mcpServers, statusLine, …) before they have explicit schemas.
  .catchall(z.unknown());
export type Config = z.infer<typeof Config>;

export const KNOWN_PROVIDERS = ["openrouter", "anthropic", "openai", "ollama"] as const;
export type ProviderName = (typeof KNOWN_PROVIDERS)[number];
