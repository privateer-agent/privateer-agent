import { homedir } from "node:os";
import { join } from "node:path";

// Global config/data dir. Overridable via PRIVATEER_HOME (portability + tests).
// Computed lazily so the env var can be set before first use.
export function globalDir(): string {
  return process.env.PRIVATEER_HOME ?? join(homedir(), ".privateer");
}

// Project-scoped config dir (./.privateer).
export function projectDir(cwd: string = process.cwd()): string {
  return join(cwd, ".privateer");
}

// Optional enterprise-managed settings file (highest precedence). Opt-in via env
// so it stays out of the way for individuals and tests.
export function managedSettingsPath(): string | undefined {
  return process.env.PRIVATEER_MANAGED_SETTINGS || undefined;
}

// The standard file/dir layout under a scope's .privateer directory. Later
// milestones (commands, agents, mcp, output styles) resolve their roots here so
// the convention lives in one place.
export interface ScopePaths {
  dir: string;
  config: string; // config.json — credentials + prefs (existing single file)
  settings: string; // settings.json — layered settings
  settingsLocal: string; // settings.local.json — gitignored local overrides
  commands: string; // commands/ — custom slash commands (M2)
  agents: string; // agents/ — custom subagents (M4)
  outputStyles: string; // output-styles/ — persona prompts (M2)
  mcp: string; // mcp.json — MCP server declarations (M4)
}

function scopePaths(dir: string): ScopePaths {
  return {
    dir,
    config: join(dir, "config.json"),
    settings: join(dir, "settings.json"),
    settingsLocal: join(dir, "settings.local.json"),
    commands: join(dir, "commands"),
    agents: join(dir, "agents"),
    outputStyles: join(dir, "output-styles"),
    mcp: join(dir, "mcp.json"),
  };
}

export function globalPaths(): ScopePaths {
  return scopePaths(globalDir());
}

export function projectPaths(cwd: string = process.cwd()): ScopePaths {
  return scopePaths(projectDir(cwd));
}
