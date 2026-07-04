import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { globalPaths, projectPaths } from "../config/paths.ts";
import { parseFrontmatter } from "../commands/custom.ts";
import { walkFiles } from "../tools/walk.ts";
import { isInsideDir } from "../tools/context.ts";
import { SKILL_NAME_RE, loadSkills } from "./loader.ts";

// Installs skills from GitHub into .privateer/skills/. Security posture: nothing
// from a fetched repo is ever executed at install time (no hooks, no scripts) —
// files are only copied. Symlinks are dropped (they could alias paths outside the
// skill), per-skill size/count caps bound the copy, and skill names are validated
// before choosing a target directory. A skill's scripts only ever run later via
// the bash tool, under the normal permission gate — the same trust model as any
// file the model reads.

const execFileAsync = promisify(execFile);

const MAX_FILES = 100;
const MAX_BYTES = 20 * 1024 * 1024;

export interface SkillSource {
  repoUrl: string;
  ref?: string;
  subpath?: string;
}

// Accepts "owner/repo", "owner/repo/path/to/skill", "https://github.com/owner/repo[.git]",
// and "https://github.com/owner/repo/tree/<ref>/<path>".
export function parseSkillSource(src: string): SkillSource {
  const s = src.trim().replace(/\/+$/, "");
  const reject = () =>
    new Error(
      `Unrecognized skill source "${src}". Use owner/repo, owner/repo/path, or a github.com URL.`,
    );
  let m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+))?)?$/.exec(s);
  let owner: string, repo: string, ref: string | undefined, subpath: string | undefined;
  if (m) {
    [, owner, repo, ref, subpath] = m;
  } else if (/^[\w.-]+\/[\w.-]+(\/.*)?$/.test(s) && !s.includes(":")) {
    const parts = s.split("/");
    [owner, repo] = parts;
    subpath = parts.length > 2 ? parts.slice(2).join("/") : undefined;
  } else {
    throw reject();
  }
  if (subpath?.split("/").some((p) => p === ".." || p === "")) throw reject();
  return { repoUrl: `https://github.com/${owner}/${repo}.git`, ref, subpath };
}

// Find installable skills (directories containing a valid SKILL.md) under a local
// directory. With a subpath that itself holds a SKILL.md, that single skill is
// returned; otherwise the tree is scanned. Pure fs — no network.
export function discoverSkills(
  rootDir: string,
  subpath?: string,
): { found: { name: string; dir: string }[]; invalid: string[] } {
  const base = subpath ? join(rootDir, subpath) : rootDir;
  if (!existsSync(base)) throw new Error(`Path "${subpath ?? "."}" not found in the repository.`);
  const candidates: string[] = [];
  if (existsSync(join(base, "SKILL.md"))) {
    candidates.push(base);
  } else {
    for (const rel of walkFiles(base)) {
      if (!rel.endsWith("/SKILL.md")) continue;
      candidates.push(join(base, rel.slice(0, -"/SKILL.md".length)));
    }
  }
  const found: { name: string; dir: string }[] = [];
  const invalid: string[] = [];
  for (const dir of candidates) {
    const { meta } = parseFrontmatter(readFileSync(join(dir, "SKILL.md"), "utf8"));
    const name = (meta.name || dir.split(sep).pop() || "").toLowerCase();
    if (!SKILL_NAME_RE.test(name) || !meta.description) {
      invalid.push(dir === base ? name || "(unnamed)" : name);
      continue;
    }
    found.push({ name, dir });
  }
  return { found, invalid };
}

// Copy one skill directory into the target, skipping symlinks and enforcing the
// per-skill caps. Cleans up the target on any failure.
export function copySkillDir(srcDir: string, destDir: string): void {
  let files = 0;
  let bytes = 0;
  const copy = (from: string, to: string) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const src = join(from, entry.name);
      const st = lstatSync(src);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        copy(src, join(to, entry.name));
      } else if (st.isFile()) {
        files += 1;
        bytes += st.size;
        if (files > MAX_FILES || bytes > MAX_BYTES) {
          throw new Error(`Skill exceeds limits (${MAX_FILES} files / ${MAX_BYTES / 1024 / 1024} MB).`);
        }
        copyFileSync(src, join(to, entry.name));
      }
    }
  };
  try {
    copy(srcDir, destDir);
  } catch (err) {
    rmSync(destDir, { recursive: true, force: true });
    throw err;
  }
}

export interface InstallOptions {
  scope: "project" | "user";
  all?: boolean;
  force?: boolean;
  cwd?: string;
}

// Install skills discovered under a local directory (the post-clone half, factored
// out so tests need neither git nor network).
export function installFromDir(
  localDir: string,
  subpath: string | undefined,
  opts: InstallOptions,
): { name: string; dir: string }[] {
  const { found, invalid } = discoverSkills(localDir, subpath);
  if (found.length === 0) {
    throw new Error(
      `No installable skills found${invalid.length ? ` (invalid: ${invalid.join(", ")})` : ""}.`,
    );
  }
  if (found.length > 1 && !opts.all) {
    throw new Error(
      `Found ${found.length} skills: ${found.map((f) => f.name).join(", ")}. ` +
        `Install one by path (install <src>/<skill-path>) or pass --all.`,
    );
  }
  const root =
    opts.scope === "project" ? projectPaths(opts.cwd ?? process.cwd()).skills : globalPaths().skills;
  const installed: { name: string; dir: string }[] = [];
  for (const skill of found) {
    const target = join(root, skill.name);
    if (existsSync(target)) {
      if (!opts.force) throw new Error(`Skill "${skill.name}" already exists at ${target}. Use --force to replace it.`);
      rmSync(target, { recursive: true, force: true });
    }
    copySkillDir(skill.dir, target);
    installed.push({ name: skill.name, dir: target });
  }
  return installed;
}

// Fetch a source from GitHub (shallow clone — no archive extraction, no execution)
// and install the skills it contains.
export async function installSkills(
  src: string,
  opts: InstallOptions,
): Promise<{ name: string; dir: string }[]> {
  const { repoUrl, ref, subpath } = parseSkillSource(src);
  const tmp = mkdtempSync(join(tmpdir(), "privateer-skill-"));
  try {
    const args = ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), repoUrl, tmp];
    await execFileAsync("git", args, { timeout: 120_000 }).catch((err) => {
      throw new Error(`git clone failed for ${repoUrl}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return installFromDir(tmp, subpath, opts);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Remove an installed skill by name. Without an explicit scope, project is tried
// first (mirroring lookup precedence). Resolves by directory name first — the
// merged loader hides a user-scope skill shadowed by a project one — and falls
// back to the loader for skills whose frontmatter name differs from their dir.
export function removeSkill(
  name: string,
  opts: { scope?: "project" | "user"; cwd?: string },
): { dir: string } {
  const cwd = opts.cwd ?? process.cwd();
  const roots =
    opts.scope === "project"
      ? [projectPaths(cwd).skills]
      : opts.scope === "user"
        ? [globalPaths().skills]
        : [projectPaths(cwd).skills, globalPaths().skills];
  // The name rule (no separators, no dots) also rules out path traversal here.
  if (SKILL_NAME_RE.test(name)) {
    for (const root of roots) {
      const dir = join(root, name);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        return { dir };
      }
    }
  }
  const skill = loadSkills(cwd).skills.find(
    (s) => s.name === name && (!opts.scope || s.scope === opts.scope),
  );
  if (skill) {
    const root = skill.scope === "project" ? projectPaths(cwd).skills : globalPaths().skills;
    if (isInsideDir(root, resolve(skill.dir))) {
      rmSync(skill.dir, { recursive: true, force: true });
      return { dir: skill.dir };
    }
  }
  throw new Error(`No installed skill "${name}"${opts.scope ? ` in ${opts.scope} scope` : ""}.`);
}
