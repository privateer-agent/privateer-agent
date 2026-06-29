import { tool } from "ai";
import { z } from "zod";
import { basename, resolve } from "node:path";
import type { ToolContext } from "./context.ts";
import { exec } from "./exec.ts";
import { PermissionDeniedError } from "../permissions/gate.ts";

const GIT_TIMEOUT = 60_000;

// Strip a worktree/branch name down to a filesystem- and git-safe slug.
function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// The sibling path a named worktree lives at: ../<repo>-wt-<name>.
function worktreePath(cwd: string, slug: string): string {
  return resolve(cwd, "..", `${basename(cwd)}-wt-${slug}`);
}

async function git(cwd: string, args: string[]) {
  return exec("git", args, { cwd, timeoutMs: GIT_TIMEOUT });
}

interface WorktreeEntry {
  path: string;
  branch?: string;
  head?: string;
}

// Parse `git worktree list --porcelain` into structured entries.
function parseWorktrees(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) entries.push(cur);
      cur = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line.startsWith("HEAD ") && cur) {
      cur.head = line.slice("HEAD ".length, "HEAD ".length + 8);
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

// The `worktree` tool: lets the agent develop a candidate approach in an isolated
// git worktree (its own branch + working copy) so a risky or exploratory direction
// never touches the main tree. Combined with `ask_user`, this is the building block
// for "try an approach, compare the diff, keep or discard it". Mutating actions
// (create/remove) run git and are routed through the permission gate.
export function worktreeTool(ctx: ToolContext) {
  return tool({
    description:
      "Manage git worktrees to develop a candidate approach in isolation (its own branch + " +
      "working copy), so an exploratory or risky direction doesn't touch the main tree. " +
      "Actions: 'create' a new worktree on a fresh branch, 'list' existing worktrees, 'remove' " +
      "one when done. Use this to try an approach the user can later compare via its diff and " +
      "keep or discard. The repository must be a git repo.",
    inputSchema: z.object({
      action: z.enum(["create", "list", "remove"]).describe("What to do."),
      name: z
        .string()
        .optional()
        .describe("Worktree/branch name for create and remove (e.g. 'redis-cache')."),
      base: z
        .string()
        .optional()
        .describe("For create: the ref to branch from (default: current HEAD)."),
      deleteBranch: z
        .boolean()
        .optional()
        .describe("For remove: also delete the worktree's branch (default false)."),
    }),
    execute: async ({ action, name, base, deleteBranch }) => {
      if (action === "list") {
        const { stdout, code } = await git(ctx.cwd, ["worktree", "list", "--porcelain"]);
        if (code !== 0) return "Not a git repository, or `git worktree` failed.";
        const entries = parseWorktrees(stdout.trim());
        if (entries.length <= 1) return "No additional worktrees. Only the main working tree exists.";
        return entries
          .map((e) => `${e.path}${e.branch ? `  [${e.branch}]` : ""}${e.head ? `  @${e.head}` : ""}`)
          .join("\n");
      }

      const slug = sanitizeName(name ?? "");
      if (!slug) return "A non-empty `name` is required for this action.";
      const path = worktreePath(ctx.cwd, slug);

      if (action === "create") {
        const args = ["worktree", "add", "-b", slug, path];
        if (base) args.push(base);
        const cmd = `git ${args.join(" ")}`;
        const decision = await ctx.gate.request({
          tool: "worktree",
          kind: "bash",
          title: "Create git worktree",
          detail: cmd,
        });
        if (decision === "deny") throw new PermissionDeniedError("worktree");
        const { stderr, code } = await git(ctx.cwd, args);
        if (code !== 0) return `git worktree add failed:\n${stderr.trim()}`;
        // Let the agent edit inside the new worktree without the confinement gate
        // re-prompting on every file — the user just approved creating it here.
        if (ctx.allowedOutsideRoots && !ctx.allowedOutsideRoots.includes(path)) {
          ctx.allowedOutsideRoots.push(path);
        }
        return (
          `Created worktree at ${path} on new branch '${slug}'.\n` +
          `Work there with absolute paths under that directory; it's isolated from the main tree. ` +
          `Compare later with: git -C "${path}" diff ${base ?? "HEAD"}`
        );
      }

      // remove
      const cmd = `git worktree remove ${path}${deleteBranch ? ` && git branch -D ${slug}` : ""}`;
      const decision = await ctx.gate.request({
        tool: "worktree",
        kind: "bash",
        title: "Remove git worktree",
        detail: cmd,
      });
      if (decision === "deny") throw new PermissionDeniedError("worktree");
      const rm = await git(ctx.cwd, ["worktree", "remove", path]);
      if (rm.code !== 0) {
        return `git worktree remove failed (commit or discard changes first, or it doesn't exist):\n${rm.stderr.trim()}`;
      }
      if (ctx.allowedOutsideRoots) {
        const i = ctx.allowedOutsideRoots.indexOf(path);
        if (i >= 0) ctx.allowedOutsideRoots.splice(i, 1);
      }
      let msg = `Removed worktree ${path}.`;
      if (deleteBranch) {
        const br = await git(ctx.cwd, ["branch", "-D", slug]);
        msg += br.code === 0 ? ` Deleted branch '${slug}'.` : ` (branch '${slug}' not deleted: ${br.stderr.trim()})`;
      }
      return msg;
    },
  });
}
