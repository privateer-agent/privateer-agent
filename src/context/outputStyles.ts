import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalPaths, projectPaths } from "../config/paths.ts";
import { walkFiles } from "../tools/walk.ts";
import { parseFrontmatter } from "../commands/custom.ts";

// A persona/behavior preset loaded from .privateer/output-styles/<name>.md. Its body
// replaces the default tone section of the system prompt while the tool policy,
// security stance, and environment grounding stay intact.
export interface OutputStyle {
  name: string;
  description?: string;
  body: string;
  scope: "project" | "user";
}

function loadFromDir(dir: string, scope: "project" | "user"): OutputStyle[] {
  if (!existsSync(dir)) return [];
  const out: OutputStyle[] = [];
  for (const rel of walkFiles(dir)) {
    if (!rel.endsWith(".md")) continue;
    const { meta, body } = parseFrontmatter(readFileSync(join(dir, rel), "utf8"));
    out.push({
      name: rel.replace(/\.md$/, "").split("/").join(":"),
      description: meta.description,
      body: body.trim(),
      scope,
    });
  }
  return out;
}

export function loadOutputStyles(cwd: string = process.cwd()): OutputStyle[] {
  const byName = new Map<string, OutputStyle>();
  for (const s of loadFromDir(globalPaths().outputStyles, "user")) byName.set(s.name, s);
  for (const s of loadFromDir(projectPaths(cwd).outputStyles, "project")) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findOutputStyle(name: string, cwd: string = process.cwd()): OutputStyle | undefined {
  return loadOutputStyles(cwd).find((s) => s.name === name);
}
