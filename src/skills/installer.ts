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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
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

// Provenance record written into each git-installed skill directory, so /skills can
// show where a skill came from and /skills update can re-fetch it. Written AFTER the
// copy so a manifest shipped inside the repo can never survive install — otherwise a
// malicious skill could point its own updates at an arbitrary repo. Manually-authored
// skills simply have no manifest and are never auto-updated.
export const MANIFEST_FILE = ".privateer-skill.json";

export interface SkillManifest {
  source: string; // the source string the user installed from, for display
  repoUrl: string; // https github.com clone URL
  ref?: string; // branch/tag pinned at install time, if any
  path: string; // skill dir relative to the repo root
  commit?: string; // resolved HEAD sha at install time
  installedAt: string;
}

const REPO_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/;

// Read and validate a skill's provenance manifest. Untrusted input (it sits in a
// directory the agent can write to), so everything used to fetch is re-validated:
// only https github.com URLs, and no path traversal in the repo-relative path.
export function readManifest(skillDir: string): SkillManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(skillDir, MANIFEST_FILE), "utf8")) as SkillManifest;
    if (typeof raw.repoUrl !== "string" || !REPO_URL_RE.test(raw.repoUrl)) return null;
    // path "" means the skill sits at the repo root; otherwise no traversal segments.
    if (typeof raw.path !== "string") return null;
    if (raw.path !== "" && raw.path.split("/").some((p) => p === ".." || p === "")) return null;
    if (raw.ref != null && typeof raw.ref !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

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
// per-skill caps. Manifest files are never copied from a source — a repo could
// otherwise ship one pointing /skills update at an arbitrary repo; provenance is
// only ever written by installFromDir itself. Cleans up the target on any failure.
export function copySkillDir(srcDir: string, destDir: string): void {
  let files = 0;
  let bytes = 0;
  const copy = (from: string, to: string) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.name === MANIFEST_FILE) continue;
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
  // Provenance of the clone being installed from; when present, a manifest is
  // written into each installed skill so it can be updated later.
  origin?: { source: string; repoUrl: string; ref?: string; commit?: string };
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
    // Written after the copy so it overwrites any manifest the repo itself shipped.
    if (opts.origin) {
      const manifest: SkillManifest = {
        ...opts.origin,
        path: relative(localDir, skill.dir).split(sep).join("/"),
        installedAt: new Date().toISOString(),
      };
      writeFileSync(join(target, MANIFEST_FILE), JSON.stringify(manifest, null, 2), "utf8");
    }
    installed.push({ name: skill.name, dir: target });
  }
  return installed;
}

// Shallow-clone a repo into a temp dir and resolve its HEAD sha. The caller must
// clean up via the returned `cleanup`. Injectable in tests via the fetchers below.
export type RepoFetcher = (
  repoUrl: string,
  ref?: string,
) => Promise<{ dir: string; commit?: string; cleanup: () => void }>;

const cloneRepo: RepoFetcher = async (repoUrl, ref) => {
  const tmp = mkdtempSync(join(tmpdir(), "privateer-skill-"));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try {
    const args = ["clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), repoUrl, tmp];
    await execFileAsync("git", args, { timeout: 120_000 });
  } catch (err) {
    cleanup();
    throw new Error(`git clone failed for ${repoUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const commit = await execFileAsync("git", ["-C", tmp, "rev-parse", "HEAD"], { timeout: 10_000 })
    .then((r) => r.stdout.trim())
    .catch(() => undefined);
  return { dir: tmp, commit, cleanup };
};

// Fetch a source from GitHub (shallow clone — no archive extraction, no execution)
// and install the skills it contains.
export async function installSkills(
  src: string,
  opts: InstallOptions,
  fetchRepo: RepoFetcher = cloneRepo,
): Promise<{ name: string; dir: string }[]> {
  const { repoUrl, ref, subpath } = parseSkillSource(src);
  const { dir, commit, cleanup } = await fetchRepo(repoUrl, ref);
  try {
    return installFromDir(dir, subpath, { ...opts, origin: { source: src, repoUrl, ref, commit } });
  } finally {
    cleanup();
  }
}

export interface UpdateResult {
  name: string;
  status: "updated" | "up-to-date" | "skipped" | "error";
  detail?: string; // e.g. "abc1234 → def5678", or why it was skipped
}

// Update installed skills from their recorded origins. `names` targets specific
// skills; "all" updates every visible skill that has a manifest. Skills without a
// manifest (authored locally or installed before manifests existed) are skipped —
// reinstall once with /skills install to make them updatable. Clones are shared
// across skills that came from the same repo+ref.
export async function updateSkills(
  names: string[] | "all",
  opts: { cwd?: string },
  fetchRepo: RepoFetcher = cloneRepo,
): Promise<UpdateResult[]> {
  const cwd = opts.cwd ?? process.cwd();
  const { skills } = loadSkills(cwd);
  const targets =
    names === "all"
      ? skills
      : names.map((n) => {
          const s = skills.find((s) => s.name === n);
          if (!s) throw new Error(`No installed skill "${n}". See /skills.`);
          return s;
        });

  const results: UpdateResult[] = [];
  // One clone per distinct repo+ref, shared by every skill that references it.
  const clones = new Map<string, Promise<{ dir: string; commit?: string; cleanup: () => void }>>();
  try {
    for (const skill of targets) {
      const manifest = readManifest(skill.dir);
      if (!manifest) {
        results.push({
          name: skill.name,
          status: "skipped",
          detail: "no install manifest (local skill, or predates manifests) — reinstall with /skills install to enable updates",
        });
        continue;
      }
      try {
        const key = `${manifest.repoUrl}#${manifest.ref ?? ""}`;
        if (!clones.has(key)) clones.set(key, fetchRepo(manifest.repoUrl, manifest.ref));
        const { dir, commit } = await clones.get(key)!;
        if (commit && manifest.commit && commit === manifest.commit) {
          results.push({ name: skill.name, status: "up-to-date", detail: commit.slice(0, 7) });
          continue;
        }
        const subpath = manifest.path === "" ? undefined : manifest.path;
        // The source path must still resolve to this same skill — checked BEFORE the
        // force-install, so an upstream rename can't overwrite the local copy with a
        // different skill under a stale name.
        const { found } = discoverSkills(dir, subpath);
        if (!found.some((s) => s.name === skill.name)) {
          results.push({
            name: skill.name,
            status: "error",
            detail: `source now provides "${found.map((s) => s.name).join(", ") || "nothing"}" — reinstall manually`,
          });
          continue;
        }
        installFromDir(dir, subpath, {
          scope: skill.scope,
          force: true,
          cwd,
          origin: { source: manifest.source, repoUrl: manifest.repoUrl, ref: manifest.ref, commit },
        });
        results.push({
          name: skill.name,
          status: "updated",
          detail: `${manifest.commit?.slice(0, 7) ?? "?"} → ${commit?.slice(0, 7) ?? "?"}`,
        });
      } catch (err) {
        results.push({
          name: skill.name,
          status: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    for (const clone of clones.values()) {
      await clone.then((c) => c.cleanup()).catch(() => {});
    }
  }
  return results;
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
