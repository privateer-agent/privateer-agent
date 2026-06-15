import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, PermissionMode } from "../config/schema.ts";
import { PERMISSION_MODES } from "../config/schema.ts";
import { configLayers } from "../config/load.ts";
import { expandCommand, type CustomCommand } from "./custom.ts";
import { loadOutputStyles } from "../context/outputStyles.ts";
import { loadAgents } from "../agents/loader.ts";
import { loadHooks } from "../hooks/engine.ts";
import { configuredProviders, parseModelSpec } from "../providers/resolve.ts";
import { effectiveTokens } from "../engine/events.ts";
import { KNOWN_PROVIDERS } from "../config/schema.ts";
import type { UsageTotals } from "../engine/events.ts";
import type { TodoItem } from "../tools/todoStore.ts";
import { VERSION } from "../version.ts";

// The result of running a slash command. The App interprets these so command logic
// stays free of React/Ink concerns and is unit-testable.
export type CommandResult =
  | { type: "notice"; text: string; tone?: "info" | "error" }
  | { type: "clear" }
  | { type: "exit" }
  | { type: "setModel"; spec: string }
  // Open the interactive model picker (fetches each provider's models live).
  | { type: "pickModel" }
  | { type: "setMode"; mode: PermissionMode }
  // Hand a prompt to the agent to run as if the user had asked it (e.g. /init).
  | { type: "runPrompt"; text: string }
  // Summarize older history to free up context.
  | { type: "compact" }
  // Toggle modal (vim) editing in the prompt input.
  | { type: "toggleVim" }
  // Toggle OpenRouter Zero-Data-Retention enforcement (pins requests to ZDR endpoints).
  | { type: "toggleZdr" }
  // Fetch + display the NEAR AI TEE attestation for the current model (resolved by the App).
  | { type: "verify" }
  // Toggle full vs truncated tool output in the transcript.
  | { type: "toggleVerbose" }
  // Switch the active output style (persona); null resets to default.
  | { type: "setOutputStyle"; name: string | null }
  // Write the conversation transcript to a markdown file (path optional).
  | { type: "export"; path?: string }
  // Open the checkpoint picker to rewind conversation and/or files.
  | { type: "rewind" }
  // Open the session picker to browse and resume a past session.
  | { type: "sessions" }
  // Show live MCP server/tool status (resolved by the App).
  | { type: "mcp" }
  // Clear saved OAuth credentials for one MCP server, or all when omitted.
  | { type: "mcpLogout"; server?: string }
  // Re-enter the provider/key onboarding flow.
  | { type: "onboarding" };

export interface CommandContext {
  config: Config;
  modelSpec: string;
  mode: PermissionMode;
  usage: UsageTotals;
  // Current context-window occupancy (estimated tokens in live history vs budget).
  // Distinct from `usage`, which is cumulative billed tokens across the whole session.
  context?: { used: number; budget: number };
  cwd: string;
  todos: TodoItem[];
  customCommands?: CustomCommand[];
}

interface CommandDef {
  name: string;
  summary: string;
  run: (args: string, ctx: CommandContext) => CommandResult;
}

const COMMANDS: CommandDef[] = [
  {
    name: "help",
    summary: "show available commands",
    run: (_args, ctx) => {
      const builtin = COMMANDS.map((c) => `  /${c.name.padEnd(11)} ${c.summary}`).join("\n");
      const custom = (ctx.customCommands ?? [])
        .map((c) => `  /${c.name.padEnd(11)} ${c.description}`)
        .join("\n");
      return {
        type: "notice",
        text: "Commands:\n" + builtin + (custom ? "\n\nCustom commands:\n" + custom : ""),
      };
    },
  },
  {
    name: "model",
    summary: "pick a model from your providers, or set one (provider:model)",
    run: (args) => {
      const spec = args.trim();
      // No argument: open the interactive picker that lists each provider's live models.
      if (!spec) return { type: "pickModel" };
      try {
        parseModelSpec(spec); // validate shape
      } catch (err) {
        return { type: "notice", tone: "error", text: (err as Error).message };
      }
      return { type: "setModel", spec };
    },
  },
  {
    name: "provider",
    summary: "list providers and their readiness",
    run: (_args, ctx) => {
      const lines = configuredProviders(ctx.config).map(
        (p) => `  ${p.ready ? "✓" : "·"} ${p.name}${p.ready ? "" : "  (no key)"}`,
      );
      return {
        type: "notice",
        text: `Providers (${KNOWN_PROVIDERS.length}):\n${lines.join("\n")}`,
      };
    },
  },
  {
    name: "login",
    summary: "add or change providers and API keys",
    run: () => ({ type: "onboarding" }),
  },
  {
    name: "permissions",
    summary: "show or set permission mode",
    run: (args, ctx) => {
      const m = args.trim();
      if (!m) {
        return {
          type: "notice",
          text: `Permission mode: ${ctx.mode}\nModes: ${PERMISSION_MODES.join(", ")}`,
        };
      }
      if (!(PERMISSION_MODES as readonly string[]).includes(m)) {
        return { type: "notice", tone: "error", text: `Unknown mode "${m}". Use: ${PERMISSION_MODES.join(", ")}` };
      }
      return { type: "setMode", mode: m as PermissionMode };
    },
  },
  {
    name: "cost",
    summary: "show token usage this session",
    run: (_args, ctx) => {
      // Headline the billed (cache-discounted) figure: the agentic loop re-sends the
      // prompt every step, so raw `totalTokens` counts each cached re-send at full
      // weight and badly overstates cost. Anthropic bills cache reads at ~10%; show
      // that estimate first, with the raw counts after for reference. See effectiveTokens.
      const u = ctx.usage;
      return {
        type: "notice",
        text:
          `Tokens — billed ~${effectiveTokens(u)} (est, cache-discounted)\n` +
          `  raw — in: ${u.inputTokens}  out: ${u.outputTokens}  total: ${u.totalTokens}  cached: ${u.cachedInputTokens}`,
      };
    },
  },
  {
    name: "init",
    summary: "analyze the repo and write PRIVATEER.md (--stub for an empty template)",
    run: (args, ctx) => {
      const path = join(ctx.cwd, "PRIVATEER.md");
      // Offline/empty template path.
      if (args.trim() === "--stub") {
        if (existsSync(path)) return { type: "notice", tone: "error", text: "PRIVATEER.md already exists." };
        writeFileSync(
          path,
          "# Project context\n\nDescribe this project, conventions, and anything Privateer should\n" +
            "always keep in mind here. This file is loaded into the system prompt.\n",
          "utf8",
        );
        return { type: "notice", text: "Created PRIVATEER.md (stub)." };
      }
      // Default: let the agent investigate and write the file itself.
      const verb = existsSync(path) ? "Update" : "Create";
      return {
        type: "runPrompt",
        text:
          `${verb} a PRIVATEER.md in the working directory. First explore the codebase ` +
          `(read package manifests, build/test config, the directory layout, and a few key ` +
          `source files). Then write a concise PRIVATEER.md covering: what the project is, how ` +
          `to build/test/run it, the high-level architecture, and any conventions a contributor ` +
          `should follow. Keep it tight — prefer bullet points over prose. Use the write tool.`,
      };
    },
  },
  {
    name: "doctor",
    summary: "environment diagnostics",
    run: (_args, ctx) => {
      const provs = configuredProviders(ctx.config)
        .map((p) => `${p.name}:${p.ready ? "ready" : "—"}`)
        .join("  ");
      const layers = configLayers()
        .map((l) => `    ${l.present ? "✓" : "·"} ${l.label} — ${l.path}`)
        .join("\n");
      return {
        type: "notice",
        text:
          `Privateer v${VERSION}\n` +
          `  node: ${process.version}\n` +
          `  cwd: ${ctx.cwd}\n` +
          `  model: ${ctx.modelSpec}\n` +
          `  mode: ${ctx.mode}\n` +
          `  providers: ${provs}\n` +
          `  config layers (low→high):\n${layers}`,
      };
    },
  },
  {
    name: "config",
    summary: "show the resolved settings layers (low→high precedence)",
    run: () => {
      const lines = configLayers().map(
        (l) => `  ${l.present ? "✓ loaded" : "· absent"}  ${l.label}\n      ${l.path}`,
      );
      return {
        type: "notice",
        text:
          "Settings layers (each overrides the ones above it):\n" +
          lines.join("\n") +
          "\n\nEdit any settings.json above; project settings.local.json is git-ignored.",
      };
    },
  },
  {
    name: "todo",
    summary: "show the current task list",
    run: (_args, ctx) => {
      if (ctx.todos.length === 0) return { type: "notice", text: "No tasks yet." };
      const mark = { completed: "✔", in_progress: "▸", pending: "○" } as const;
      const lines = ctx.todos.map((t) => `  ${mark[t.status]} ${t.content}`);
      return { type: "notice", text: `Tasks:\n${lines.join("\n")}` };
    },
  },
  {
    name: "context",
    summary: "show context-window usage",
    run: (_args, ctx) => {
      const u = ctx.usage;
      const budget = ctx.config.contextBudget;
      // Window occupancy is the size of the live history, NOT cumulative billed
      // tokens — the agentic loop re-sends the prompt each step, so `usage.totalTokens`
      // is many times the window and would report a meaningless % here.
      const used = ctx.context?.used ?? 0;
      const pct = budget ? Math.round((used / budget) * 100) : 0;
      const compactAt = Math.round(budget * ctx.config.compactRatio);
      const billed = effectiveTokens(u);
      return {
        type: "notice",
        text:
          `Context window:\n` +
          `  used: ${used} tokens (${pct}% of ${budget})\n` +
          `  auto-compact at ~${compactAt} tokens (ratio ${ctx.config.compactRatio})\n` +
          `Session billed (cumulative, all turns):\n` +
          `  in: ${u.inputTokens}  out: ${u.outputTokens}  cached: ${u.cachedInputTokens}\n` +
          `  total: ${u.totalTokens}  billed (est, cache-discounted): ~${billed} tokens`,
      };
    },
  },
  {
    name: "memory",
    summary: "show the project memory file (PRIVATEER.md)",
    run: (_args, ctx) => {
      const path = join(ctx.cwd, "PRIVATEER.md");
      if (!existsSync(path)) {
        return {
          type: "notice",
          text: "No PRIVATEER.md yet. Use /init to create one, or `# <note>` to append a line.",
        };
      }
      const body = readFileSync(path, "utf8").trim();
      const shown = body.length > 1500 ? body.slice(0, 1500) + "\n… (truncated)" : body;
      return { type: "notice", text: `PRIVATEER.md:\n${shown}` };
    },
  },
  {
    name: "export",
    summary: "write the conversation to a markdown file",
    run: (args) => ({ type: "export", path: args.trim() || undefined }),
  },
  {
    name: "rewind",
    summary: "restore an earlier checkpoint (conversation and/or files)",
    run: () => ({ type: "rewind" }),
  },
  {
    name: "resume",
    summary: "browse and resume a past session",
    run: () => ({ type: "sessions" }),
  },
  {
    name: "sessions",
    summary: "browse and resume a past session",
    run: () => ({ type: "sessions" }),
  },
  {
    name: "mcp",
    summary: "MCP servers: show status, or `logout [server]` to clear saved OAuth",
    run: (args) => {
      const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (sub === "logout") return { type: "mcpLogout", server: rest.join(" ") || undefined };
      return { type: "mcp" };
    },
  },
  {
    name: "hooks",
    summary: "list configured lifecycle hooks",
    run: (_args, ctx) => {
      const hooks = loadHooks((ctx.config as Record<string, unknown>).hooks);
      const events = Object.keys(hooks);
      if (events.length === 0) {
        return {
          type: "notice",
          text: "No hooks configured. Add a `hooks` section to .privateer/settings.json (events: PreToolUse, PostToolUse, UserPromptSubmit, Stop).",
        };
      }
      const lines = events.flatMap((ev) =>
        (hooks[ev as keyof typeof hooks] ?? []).map(
          (h) => `  ${ev}${h.matcher ? ` [${h.matcher}]` : ""}: ${h.command}`,
        ),
      );
      return { type: "notice", text: `Hooks:\n${lines.join("\n")}` };
    },
  },
  {
    name: "agents",
    summary: "list custom sub-agents from .privateer/agents",
    run: (_args, ctx) => {
      const agents = loadAgents(ctx.cwd);
      if (agents.length === 0) {
        return {
          type: "notice",
          text: "No custom sub-agents. Add markdown files under .privateer/agents/ (use them via the task tool's subagent_type).",
        };
      }
      const lines = agents.map((a) => {
        const tools = a.tools?.length ? a.tools.join(", ") : "read, glob, grep";
        const model = a.model ? ` · ${a.model}` : "";
        return `  ${a.name} (${a.scope})${model}\n    ${a.description}\n    tools: ${tools}`;
      });
      return { type: "notice", text: `Sub-agents:\n${lines.join("\n")}` };
    },
  },
  {
    name: "compact",
    summary: "summarize older history to free up context",
    run: () => ({ type: "compact" }),
  },
  {
    name: "vim",
    summary: "toggle modal (vim) editing in the prompt",
    run: () => ({ type: "toggleVim" }),
  },
  {
    name: "zdr",
    summary: "toggle OpenRouter Zero-Data-Retention enforcement on requests",
    run: (_args, ctx) => {
      if (!ctx.config.providers.openrouter?.apiKey) {
        return {
          type: "notice",
          tone: "error",
          text: "ZDR enforcement applies to OpenRouter. Add an OpenRouter key with /login first.",
        };
      }
      return { type: "toggleZdr" };
    },
  },
  {
    name: "verify",
    summary: "show the NEAR AI TEE attestation proving the current model runs privately",
    run: (_args, ctx) => {
      let provider = "";
      try {
        ({ provider } = parseModelSpec(ctx.modelSpec));
      } catch {
        /* malformed model spec → handled below */
      }
      if (provider !== "nearai") {
        return {
          type: "notice",
          tone: "error",
          text: "/verify attests NEAR AI models. Switch to a nearai:* model with /model first.",
        };
      }
      if (!ctx.config.providers.nearai?.apiKey) {
        return {
          type: "notice",
          tone: "error",
          text: "No NEAR AI key. Add one with /login (or set NEAR_AI_API_KEY) to fetch an attestation.",
        };
      }
      return { type: "verify" };
    },
  },
  {
    name: "verbose",
    summary: "toggle full vs truncated tool output",
    run: () => ({ type: "toggleVerbose" }),
  },
  {
    name: "output-style",
    summary: "switch the output style (persona), or list the available styles",
    run: (args, ctx) => {
      const name = args.trim();
      const styles = loadOutputStyles(ctx.cwd);
      if (!name) {
        const current = ctx.config.outputStyle ?? "default";
        const list = styles.length
          ? styles.map((s) => `  ${s.name}${s.description ? " — " + s.description : ""}`).join("\n")
          : "  (none found in .privateer/output-styles)";
        return {
          type: "notice",
          text:
            `Output style: ${current}\nAvailable:\n${list}\n\n` +
            `Use /output-style <name>, or /output-style default to reset.`,
        };
      }
      if (name === "default") return { type: "setOutputStyle", name: null };
      if (!styles.some((s) => s.name === name)) {
        return { type: "notice", tone: "error", text: `No output style "${name}". See /output-style.` };
      }
      return { type: "setOutputStyle", name };
    },
  },
  {
    name: "clear",
    summary: "clear the conversation",
    run: () => ({ type: "clear" }),
  },
  {
    name: "exit",
    summary: "quit Privateer",
    run: () => ({ type: "exit" }),
  },
  { name: "quit", summary: "quit Privateer", run: () => ({ type: "exit" }) },
];

export const COMMAND_NAMES = COMMANDS.map((c) => c.name);

// Name + summary for each built-in command, for the slash-command autocomplete menu.
export const COMMAND_LIST: { name: string; summary: string }[] = COMMANDS.map((c) => ({
  name: c.name,
  summary: c.summary,
}));

// Built-ins plus any custom commands, for autocomplete.
export function commandList(custom: CustomCommand[] = []): { name: string; summary: string }[] {
  return [...COMMAND_LIST, ...custom.map((c) => ({ name: c.name, summary: c.description }))];
}

// Parse and run a "/command args" line. Returns null if not a slash command.
// Falls through to custom commands (expanded into a prompt) before erroring.
export function runCommand(raw: string, ctx: CommandContext): CommandResult | null {
  if (!raw.startsWith("/")) return null;
  const [name, ...rest] = raw.slice(1).split(" ");
  const args = rest.join(" ");
  const cmd = COMMANDS.find((c) => c.name === name);
  if (cmd) return cmd.run(args, ctx);
  const custom = ctx.customCommands?.find((c) => c.name === name);
  if (custom) return { type: "runPrompt", text: expandCommand(custom, args) };
  return { type: "notice", tone: "error", text: `Unknown command "/${name}". Try /help.` };
}
