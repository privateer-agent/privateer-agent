import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { loadSkills, type SkillDefinition } from "../skills/loader.ts";

// Progressive disclosure for skills: the model sees only the catalog (names +
// descriptions, embedded in this tool's description — same pattern as `task`
// advertising sub-agents) and pulls a skill's full instructions into the
// conversation by calling the tool. Loading a skill also unlocks reads of its
// bundled files, which live outside cwd for user-scoped skills.
export function skillTool(ctx: ToolContext, skills?: SkillDefinition[]) {
  const list = skills ?? loadSkills(ctx.cwd).skills;
  return tool({
    description:
      "Load a skill — a package of expert instructions for a specific kind of task. " +
      "When a listed skill matches the user's request, load it BEFORE attempting the " +
      "task and follow its instructions. Available skills:\n" +
      list.map((s) => `- ${s.name}: ${s.description}`).join("\n"),
    inputSchema: z.object({
      skill: z.string().describe("Name of the skill to load."),
    }),
    execute: async ({ skill }) => {
      const def = list.find((s) => s.name === skill);
      if (!def) {
        const names = list.map((s) => s.name).join(", ") || "(none)";
        return `No skill named "${skill}". Available: ${names}.`;
      }
      // Bundled files (scripts/, references/, ...) sit next to SKILL.md — for a
      // user-scoped skill that's outside cwd, so mark the directory in-scope for
      // this session rather than prompting on every read.
      const roots = (ctx.allowedOutsideRoots ??= []);
      if (!roots.includes(def.dir)) roots.push(def.dir);
      const advisory = def.allowedTools?.length
        ? `\nDeclared allowed-tools: ${def.allowedTools.join(", ")} (advisory in this version).`
        : "";
      return (
        `Skill "${def.name}" loaded (base directory: ${def.dir}). ` +
        `Bundled files can be read with the read tool using paths under that directory.` +
        advisory +
        `\n\n${def.body}`
      );
    },
  });
}
