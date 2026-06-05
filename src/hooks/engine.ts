import type { ToolSet } from "ai";
import { exec } from "../tools/exec.ts";

// A single hook: a shell command, optionally gated by a regex matched against the
// tool name (tool events only). Loaded from settings under the `hooks` key.
export interface HookDef {
  matcher?: string;
  command: string;
}

export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";
export type HooksConfig = Partial<Record<HookEvent, HookDef[]>>;

// Aggregated result of firing an event's hooks.
export interface HookOutcome {
  block?: boolean; // PreToolUse / UserPromptSubmit may veto
  reason?: string;
  additionalContext?: string; // UserPromptSubmit may inject extra context
}

const HOOK_TIMEOUT_MS = 30_000;
const KNOWN_EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"];

// Parse the loosely-typed `hooks` section of settings into a validated HooksConfig.
export function loadHooks(raw: unknown): HooksConfig {
  if (typeof raw !== "object" || raw === null) return {};
  const out: HooksConfig = {};
  for (const event of KNOWN_EVENTS) {
    const entries = (raw as Record<string, unknown>)[event];
    if (!Array.isArray(entries)) continue;
    const defs: HookDef[] = [];
    for (const e of entries) {
      if (e && typeof e === "object" && typeof (e as any).command === "string") {
        defs.push({ matcher: (e as any).matcher, command: (e as any).command });
      }
    }
    if (defs.length) out[event] = defs;
  }
  return out;
}

function matches(def: HookDef, toolName?: string): boolean {
  if (!def.matcher) return true;
  if (toolName === undefined) return true;
  try {
    return new RegExp(def.matcher).test(toolName);
  } catch {
    return false; // invalid regex → don't match
  }
}

// Fire one hook with a JSON payload on stdin; interpret its result. A hook blocks by
// exiting with code 2 (reason from stderr) or printing JSON with decision "block"/"deny".
// It may inject context via { "additionalContext": "..." }.
async function fireHook(def: HookDef, payload: unknown, cwd: string): Promise<HookOutcome> {
  const res = await exec(def.command, [], {
    cwd,
    timeoutMs: HOOK_TIMEOUT_MS,
    shell: true,
    input: JSON.stringify(payload),
  });
  if (res.code === 2) return { block: true, reason: res.stderr.trim() || "blocked by hook" };
  const stdout = res.stdout.trim();
  if (stdout.startsWith("{")) {
    try {
      const out = JSON.parse(stdout) as Record<string, unknown>;
      const decision = (out.decision ?? out.permissionDecision) as string | undefined;
      return {
        block: decision === "block" || decision === "deny",
        reason: (out.reason ?? out.permissionDecisionReason) as string | undefined,
        additionalContext: out.additionalContext as string | undefined,
      };
    } catch {
      /* not JSON → no control signal */
    }
  }
  return {};
}

// Runs the configured hooks for each lifecycle event.
export class HookRunner {
  constructor(
    private readonly hooks: HooksConfig,
    private readonly cwd: string,
  ) {}

  has(event: HookEvent): boolean {
    return (this.hooks[event]?.length ?? 0) > 0;
  }

  config(): HooksConfig {
    return this.hooks;
  }

  // Fire tool-event hooks (Pre/PostToolUse). The first hook to block wins.
  async tool(
    event: "PreToolUse" | "PostToolUse",
    toolName: string,
    payload: { input: unknown; output?: unknown },
  ): Promise<HookOutcome> {
    const defs = (this.hooks[event] ?? []).filter((d) => matches(d, toolName));
    let merged: HookOutcome = {};
    for (const def of defs) {
      const outcome = await fireHook(def, { event, tool: toolName, ...payload, cwd: this.cwd }, this.cwd);
      if (outcome.block) return outcome;
      merged = { ...merged, ...outcome };
    }
    return merged;
  }

  // Fire UserPromptSubmit hooks; a block vetoes the turn, additionalContext is merged.
  async prompt(text: string): Promise<HookOutcome> {
    const defs = this.hooks.UserPromptSubmit ?? [];
    let context = "";
    for (const def of defs) {
      const outcome = await fireHook(def, { event: "UserPromptSubmit", prompt: text, cwd: this.cwd }, this.cwd);
      if (outcome.block) return outcome;
      if (outcome.additionalContext) context += (context ? "\n" : "") + outcome.additionalContext;
    }
    return context ? { additionalContext: context } : {};
  }

  // Fire Stop hooks (turn finished); fire-and-report, no control flow.
  async stop(): Promise<void> {
    for (const def of this.hooks.Stop ?? []) {
      await fireHook(def, { event: "Stop", cwd: this.cwd }, this.cwd);
    }
  }
}

// Wrap each tool's execute with Pre/PostToolUse hooks. A blocking PreToolUse hook
// short-circuits the call, returning the reason so the model can adapt. No-op when no
// tool hooks are configured.
export function wrapToolsWithHooks(tools: ToolSet, runner: HookRunner): ToolSet {
  if (!runner.has("PreToolUse") && !runner.has("PostToolUse")) return tools;
  const wrapped: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    const orig = (t as any).execute;
    if (typeof orig !== "function") {
      wrapped[name] = t;
      continue;
    }
    wrapped[name] = {
      ...(t as any),
      execute: async (input: unknown, options: unknown) => {
        const pre = await runner.tool("PreToolUse", name, { input });
        if (pre.block) return `Blocked by PreToolUse hook: ${pre.reason ?? "no reason given"}`;
        const output = await orig(input, options);
        await runner.tool("PostToolUse", name, { input, output });
        return output;
      },
    } as ToolSet[string];
  }
  return wrapped;
}
