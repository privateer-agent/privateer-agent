import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalPaths, projectPaths } from "../config/paths.ts";
import { parseFrontmatter } from "../commands/custom.ts";

// An agent skill: a directory under .privateer/skills/ containing SKILL.md
// (frontmatter + instruction body) plus optional bundled files (scripts/,
// references/, ...). Format-compatible with Claude Code skills, so published
// skills work when dropped in unchanged. The model sees only name+description
// (the catalog in the `skill` tool); the body is loaded on demand.
export interface SkillDefinition {
  name: string; // frontmatter `name`, else the directory name
  description: string; // required — a skill without one is skipped
  allowedTools?: string[]; // frontmatter `allowed-tools` — parsed, advisory in v1
  model?: string; // parsed, unused in v1 (skills run inline in the main loop)
  body: string; // SKILL.md body — the instructions
  dir: string; // absolute skill directory, base path for bundled files
  scope: "project" | "user";
}

// Lowercase alphanumeric + hyphens, ≤64 chars (the Claude Code skill-name rule).
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function loadFromDir(
  root: string,
  scope: "project" | "user",
): { skills: SkillDefinition[]; warnings: string[] } {
  const skills: SkillDefinition[] = [];
  const warnings: string[] = [];
  if (!existsSync(root)) return { skills, warnings };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) continue;
    const { meta, body } = parseFrontmatter(readFileSync(file, "utf8"));
    const name = (meta.name || entry.name).toLowerCase();
    if (!SKILL_NAME_RE.test(name)) {
      warnings.push(`${scope} skill "${entry.name}": invalid name "${name}" — skipped`);
      continue;
    }
    if (!meta.description) {
      warnings.push(`${scope} skill "${name}": missing description — skipped`);
      continue;
    }
    if (meta.name && meta.name.toLowerCase() !== entry.name.toLowerCase()) {
      warnings.push(`${scope} skill "${name}": directory is named "${entry.name}"`);
    }
    skills.push({
      name,
      description: meta.description,
      allowedTools: meta["allowed-tools"]
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      model: meta.model,
      body: body.trim(),
      dir,
      scope,
    });
  }
  return { skills, warnings };
}

// User (~/.privateer/skills) then project (./.privateer/skills); a project skill
// overrides a user skill of the same name.
export function loadSkills(cwd: string = process.cwd()): {
  skills: SkillDefinition[];
  warnings: string[];
} {
  const byName = new Map<string, SkillDefinition>();
  const warnings: string[] = [];
  for (const scoped of [
    loadFromDir(globalPaths().skills, "user"),
    loadFromDir(projectPaths(cwd).skills, "project"),
  ]) {
    for (const s of scoped.skills) byName.set(s.name, s);
    warnings.push(...scoped.warnings);
  }
  return {
    skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}

export function findSkill(name: string, cwd: string = process.cwd()): SkillDefinition | undefined {
  return loadSkills(cwd).skills.find((s) => s.name === name);
}
