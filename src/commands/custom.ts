import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalPaths, projectPaths } from "../config/paths.ts";
import { walkFiles } from "../tools/walk.ts";

// A user-authored slash command loaded from a markdown file under
// .privateer/commands/. The body is a prompt template; frontmatter is optional.
export interface CustomCommand {
  name: string; // file path minus .md, separators → ":" (e.g. "git/pr.md" → "git:pr")
  description: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  body: string;
  scope: "project" | "user";
}

// Minimal YAML-ish frontmatter: a leading `---` block of `key: value` lines.
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      i++;
      break;
    }
    const m = lines[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return { meta, body: lines.slice(i).join("\n").replace(/^\n+/, "") };
}

function loadFromDir(dir: string, scope: "project" | "user"): CustomCommand[] {
  if (!existsSync(dir)) return [];
  const out: CustomCommand[] = [];
  for (const rel of walkFiles(dir)) {
    if (!rel.endsWith(".md")) continue;
    const { meta, body } = parseFrontmatter(readFileSync(join(dir, rel), "utf8"));
    out.push({
      name: rel.replace(/\.md$/, "").split("/").join(":"),
      description: meta.description ?? `custom ${scope} command`,
      argumentHint: meta["argument-hint"],
      allowedTools: meta["allowed-tools"]
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      model: meta.model,
      body: body.trim(),
      scope,
    });
  }
  return out;
}

// Load custom commands from user (~/.privateer) then project (./.privateer);
// a project command overrides a user command of the same name.
export function loadCustomCommands(cwd: string = process.cwd()): CustomCommand[] {
  const byName = new Map<string, CustomCommand>();
  for (const c of loadFromDir(globalPaths().commands, "user")) byName.set(c.name, c);
  for (const c of loadFromDir(projectPaths(cwd).commands, "project")) byName.set(c.name, c);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Expand a command body against its arguments: $1..$9 are positional words,
// $ARGUMENTS and $@ are the full argument string.
export function expandCommand(cmd: CustomCommand, argString: string): string {
  const args = argString.trim();
  const parts = args.length ? args.split(/\s+/) : [];
  return cmd.body
    .replace(/\$([1-9])/g, (_, d: string) => parts[Number(d) - 1] ?? "")
    .replace(/\$ARGUMENTS\b/g, args)
    .replace(/\$@/g, args);
}
