import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { globalDir } from "../config/load.ts";
import { parseFrontmatter } from "../commands/custom.ts";
import { projectKey } from "./store.ts";

// Agent-authored "auto-memory": durable facts the agent records across runs, modeled on
// Claude Code's memory files. Each memory is one markdown file with flat frontmatter
// (so it round-trips through parseFrontmatter, which only reads `key: value` lines) plus
// a body. A per-scope MEMORY.md index lists them and is recalled into the system prompt.
//
// Two scopes: "project" memories live under the per-project dir (keyed by cwd) and only
// recall in that project; "global" memories live under the global dir and recall
// everywhere. Project memories win on a name clash.

export type MemoryType = "user" | "feedback" | "project" | "reference";
export type MemoryScope = "project" | "global";

export interface MemoryRecord {
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  body: string;
  path: string;
}

const INDEX_FILE = "MEMORY.md";
const VALID_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

function memoryDir(scope: MemoryScope, cwd: string): string {
  return scope === "global"
    ? join(globalDir(), "memory")
    : join(globalDir(), "projects", projectKey(cwd), "memory");
}

// Constrain a proposed name to a safe, kebab-ish file stem (no path traversal, no spaces).
export function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
}

function coerceType(raw: string | undefined): MemoryType {
  return VALID_TYPES.includes(raw as MemoryType) ? (raw as MemoryType) : "project";
}

function readDir(scope: MemoryScope, cwd: string): MemoryRecord[] {
  const dir = memoryDir(scope, cwd);
  if (!existsSync(dir)) return [];
  const out: MemoryRecord[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md") || file === INDEX_FILE) continue;
    const path = join(dir, file);
    const { meta, body } = parseFrontmatter(readFileSync(path, "utf8"));
    const name = meta.name || file.replace(/\.md$/, "");
    out.push({
      name,
      description: meta.description ?? "",
      type: coerceType(meta.type),
      scope,
      body: body.trim(),
      path,
    });
  }
  return out;
}

// Regenerate a scope's MEMORY.md from the memory files it contains. Regenerating (vs.
// editing in place) keeps the index free of stale or duplicate lines.
function rebuildIndex(scope: MemoryScope, cwd: string): void {
  const dir = memoryDir(scope, cwd);
  const records = readDir(scope, cwd).sort((a, b) => a.name.localeCompare(b.name));
  const indexPath = join(dir, INDEX_FILE);
  if (records.length === 0) {
    if (existsSync(indexPath)) rmSync(indexPath, { force: true });
    return;
  }
  const lines = [
    "# Memory Index",
    "",
    ...records.map((r) => `- [${r.name}](${r.name}.md) — ${r.description}`),
    "",
  ];
  mkdirSync(dir, { recursive: true });
  writeFileSync(indexPath, lines.join("\n"), "utf8");
}

// All memories visible from this cwd: project entries override global on a name clash.
export function listMemories(cwd: string): MemoryRecord[] {
  const byName = new Map<string, MemoryRecord>();
  for (const r of readDir("global", cwd)) byName.set(r.name, r);
  for (const r of readDir("project", cwd)) byName.set(r.name, r);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function readMemory(cwd: string, name: string): MemoryRecord | null {
  const key = sanitizeName(name);
  return listMemories(cwd).find((r) => r.name === key) ?? null;
}

export function saveMemory(
  cwd: string,
  input: { name: string; description: string; type?: MemoryType; scope?: MemoryScope; body: string },
): MemoryRecord {
  const scope: MemoryScope = input.scope === "global" ? "global" : "project";
  const name = sanitizeName(input.name);
  if (!name) throw new Error("memory name is empty after sanitizing");
  const type = coerceType(input.type);
  const dir = memoryDir(scope, cwd);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${input.description.replace(/\n/g, " ").trim()}`,
    `type: ${type}`,
    `scope: ${scope}`,
    "---",
  ].join("\n");
  writeFileSync(path, `${frontmatter}\n${input.body.trim()}\n`, "utf8");
  rebuildIndex(scope, cwd);
  return { name, description: input.description, type, scope, body: input.body.trim(), path };
}

export function deleteMemory(cwd: string, name: string): MemoryRecord | null {
  const existing = readMemory(cwd, name);
  if (!existing) return null;
  rmSync(existing.path, { force: true });
  rebuildIndex(existing.scope, cwd);
  return existing;
}

// The memory index(es) to recall into the system prompt, or null when there are none.
export function loadMemoryContext(cwd: string): string | null {
  const sections: string[] = [];
  for (const scope of ["project", "global"] as const) {
    const indexPath = join(memoryDir(scope, cwd), INDEX_FILE);
    if (!existsSync(indexPath)) continue;
    const body = readFileSync(indexPath, "utf8").trim();
    if (body) sections.push(`(${scope})\n${body}`);
  }
  return sections.length ? sections.join("\n\n") : null;
}
