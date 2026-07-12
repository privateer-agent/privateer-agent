/**
 * Skill management for linked terminals.
 *
 * A UI-agnostic wrapper over Pi's skills loader so the app (over the relay) can
 * see which skills THIS terminal has, and create / edit / delete / toggle the
 * user's OWN ones — the sibling of extensionsControl.ts (which does the same for
 * Pi extensions). Both the dev REPL (src/cli/chat.ts) and the shipped TUI
 * (extensions/privateer-gate.ts) build one of these and route the skills_* relay
 * frames through it.
 *
 * A skill is a directory holding a SKILL.md (YAML frontmatter `name` +
 * `description`, then a markdown instructions body); Pi auto-loads it into the
 * system prompt and exposes it as `/skill:name`. See pi.dev/docs/latest/skills.
 *
 * Only the user's OWN skills — the ones under <agentDir>/skills/ — are editable.
 * Skills that come from packages or the project tree surface read-only
 * (editable:false); we never rewrite or delete files we didn't author.
 *
 * Framework-agnostic: nothing here imports React or the relay. The caller owns the
 * frame plumbing and hands us a SettingsManager (the REPL reuses the session's;
 * the TUI creates a fresh one — both read the same ~/.privateer/agent/settings.json).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

// One skill as surfaced to the app. NON-PII: a name + description + a coarse
// `source` label ("user"/"project"/a package name) — no absolute paths. `editable`
// is true only for the user's own skills under <agentDir>/skills/, which we may
// rewrite/delete. `disabled` mirrors the SKILL.md `disable-model-invocation` flag.
export interface RemoteSkill {
  name: string;
  description: string;
  source: string;
  editable: boolean;
  disabled: boolean;
}

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
}

export interface SkillsControl {
  // All discovered skills (user + project + package), user ones flagged editable.
  listSkills(): RemoteSkill[];
  // Create or overwrite a user skill at <agentDir>/skills/<name>/SKILL.md.
  createSkill(draft: SkillDraft): Promise<{ ok: boolean; message?: string }>;
  // Delete a user skill's directory. Refuses non-editable (package/project) skills.
  deleteSkill(name: string): Promise<{ ok: boolean; message?: string }>;
  // Flip a user skill's `disable-model-invocation` frontmatter (editable only).
  setEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; message?: string }>;
}

// A skill name per the Agent Skills standard: lowercase a-z0-9-, ≤64 chars, no
// leading/trailing/consecutive hyphens. Doubles as the directory name, so this also
// keeps it filesystem-safe (no slashes, dots, traversal).
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validName(name: string): boolean {
  return typeof name === "string" && name.length > 0 && name.length <= 64 && NAME_RE.test(name);
}

// Serialize a SKILL.md: YAML frontmatter (name, description, and the invocation
// flag only when disabled) + the instructions body. Values are single-line and
// name-validated, so a plain quoted scalar is safe without a YAML dependency.
function renderSkillMd(draft: SkillDraft, disabled: boolean): string {
  const q = (s: string) => JSON.stringify(String(s ?? "")); // JSON string ⊂ YAML flow scalar
  const lines = ["---", `name: ${q(draft.name)}`, `description: ${q(draft.description)}`];
  if (disabled) lines.push("disable-model-invocation: true");
  lines.push("---", "");
  const body = (draft.instructions ?? "").replace(/\r\n/g, "\n").trimEnd();
  return lines.join("\n") + (body ? body + "\n" : "");
}

export function makeSkillsControl(opts: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
}): SkillsControl {
  // The user's own global skills live here; only these are editable.
  const userSkillsDir = path.join(opts.agentDir, "skills");

  // Is this loaded skill one of ours (under <agentDir>/skills/)? Compared on the
  // skill's baseDir/filePath so a symlinked or package skill of the same name can't
  // masquerade as editable.
  function isEditable(baseDir: string | undefined, filePath: string): boolean {
    const p = path.resolve(baseDir || path.dirname(filePath));
    const root = path.resolve(userSkillsDir);
    return p === root || p.startsWith(root + path.sep);
  }

  function load(): RemoteSkill[] {
    let skillPaths: string[] = [];
    try {
      skillPaths = opts.settingsManager.getSkillPaths() ?? [];
    } catch {
      skillPaths = [];
    }
    let result;
    try {
      result = loadSkills({ cwd: opts.cwd, agentDir: opts.agentDir, skillPaths, includeDefaults: true });
    } catch {
      return [];
    }
    return result.skills.map((sk) => ({
      name: sk.name,
      description: sk.description,
      source: sk.sourceInfo?.scope === "project" ? "project" : sk.sourceInfo?.source || "user",
      editable: isEditable(sk.baseDir, sk.filePath),
      disabled: !!sk.disableModelInvocation,
    }));
  }

  // The user skill file to rewrite/delete for `name`. Only ever inside userSkillsDir.
  function skillDir(name: string): string {
    return path.join(userSkillsDir, name);
  }

  return {
    listSkills(): RemoteSkill[] {
      return load();
    },

    async createSkill(draft: SkillDraft): Promise<{ ok: boolean; message?: string }> {
      const name = (draft?.name ?? "").trim();
      const description = (draft?.description ?? "").trim();
      if (!validName(name)) {
        return { ok: false, message: "Name must be lowercase letters, numbers and single hyphens (max 64)." };
      }
      if (!description) return { ok: false, message: "A description is required." };
      // Refuse to shadow a non-editable skill (package/project) that owns this name.
      const clash = load().find((s) => s.name === name && !s.editable);
      if (clash) return { ok: false, message: `A ${clash.source} skill named "${name}" already exists.` };
      // Preserve the disabled state on edit; a brand-new skill defaults to enabled.
      const existing = load().find((s) => s.name === name && s.editable);
      const disabled = existing?.disabled ?? false;
      try {
        const dir = skillDir(name);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "SKILL.md"), renderSkillMd({ name, description, instructions: draft.instructions }, disabled), "utf8");
        return { ok: true };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },

    async deleteSkill(name: string): Promise<{ ok: boolean; message?: string }> {
      const n = (name ?? "").trim();
      if (!validName(n)) return { ok: false, message: "Unknown skill." };
      const skill = load().find((s) => s.name === n);
      if (!skill) return { ok: false, message: "Not found." };
      if (!skill.editable) return { ok: false, message: "That skill is read-only." };
      try {
        await fs.rm(skillDir(n), { recursive: true, force: true });
        return { ok: true };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },

    async setEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; message?: string }> {
      const n = (name ?? "").trim();
      if (!validName(n)) return { ok: false, message: "Unknown skill." };
      const skill = load().find((s) => s.name === n);
      if (!skill) return { ok: false, message: "Not found." };
      if (!skill.editable) return { ok: false, message: "That skill is read-only." };
      try {
        const file = path.join(skillDir(n), "SKILL.md");
        const raw = await fs.readFile(file, "utf8");
        const rewritten = toggleFrontmatterFlag(raw, !enabled);
        await fs.writeFile(file, rewritten, "utf8");
        return { ok: true };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
  };
}

// Set or clear `disable-model-invocation` in an existing SKILL.md's frontmatter,
// preserving the rest of the file byte-for-byte. Rewrites only the flag line.
function toggleFrontmatterFlag(raw: string, disabled: boolean): string {
  const nl = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    // No frontmatter — synthesize a minimal one so the flag lands somewhere valid.
    return `---${nl}disable-model-invocation: ${disabled}${nl}---${nl}${raw}`;
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
  }
  if (end === -1) return raw; // malformed; leave untouched
  const flagIdx = lines.findIndex((l, i) => i > 0 && i < end && /^\s*disable-model-invocation\s*:/.test(l));
  if (disabled) {
    if (flagIdx === -1) lines.splice(end, 0, "disable-model-invocation: true");
    else lines[flagIdx] = "disable-model-invocation: true";
  } else if (flagIdx !== -1) {
    lines.splice(flagIdx, 1);
  }
  return lines.join(nl);
}
