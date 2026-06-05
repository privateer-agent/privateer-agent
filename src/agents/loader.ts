import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalPaths, projectPaths } from "../config/paths.ts";
import { walkFiles } from "../tools/walk.ts";
import { parseFrontmatter } from "../commands/custom.ts";

// A user-defined sub-agent loaded from .privateer/agents/<name>.md. The body is the
// agent's instructions (system prompt); frontmatter narrows its tools and model.
export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[]; // tool names the agent may use (default: read/glob/grep)
  model?: string; // optional "provider:model" override
  prompt: string; // the agent's instructions
  scope: "project" | "user";
}

function loadFromDir(dir: string, scope: "project" | "user"): AgentDefinition[] {
  if (!existsSync(dir)) return [];
  const out: AgentDefinition[] = [];
  for (const rel of walkFiles(dir)) {
    if (!rel.endsWith(".md")) continue;
    const { meta, body } = parseFrontmatter(readFileSync(join(dir, rel), "utf8"));
    out.push({
      name: meta.name || rel.replace(/\.md$/, "").split("/").join(":"),
      description: meta.description ?? `custom ${scope} sub-agent`,
      tools: meta.tools
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      model: meta.model,
      prompt: body.trim(),
      scope,
    });
  }
  return out;
}

// User (~/.privateer) then project (./.privateer) agents; project overrides user.
export function loadAgents(cwd: string = process.cwd()): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  for (const a of loadFromDir(globalPaths().agents, "user")) byName.set(a.name, a);
  for (const a of loadFromDir(projectPaths(cwd).agents, "project")) byName.set(a.name, a);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findAgent(name: string, cwd: string = process.cwd()): AgentDefinition | undefined {
  return loadAgents(cwd).find((a) => a.name === name);
}
