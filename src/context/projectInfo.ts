import { execFileSync } from "node:child_process";
import { walkFiles } from "../tools/walk.ts";

// Lightweight, synchronous environment probes used to enrich the system prompt at
// session start. Everything here fails soft: outside a git repo, or if `git` is
// missing, the git block is simply omitted rather than throwing.

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 3_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export interface GitInfo {
  branch: string;
  status: string; // short porcelain, possibly truncated
  recent: string; // last few commit subjects
}

// A compact git snapshot, or null when cwd isn't a working tree.
export function gitStatus(cwd: string): GitInfo | null {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return null;

  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || "(detached)";
  const raw = git(cwd, ["status", "--porcelain"]) ?? "";
  const lines = raw ? raw.split("\n") : [];
  const status =
    lines.length === 0
      ? "(clean)"
      : lines.slice(0, 20).join("\n") +
        (lines.length > 20 ? `\n… (+${lines.length - 20} more)` : "");
  const recent = git(cwd, ["log", "--oneline", "-5"]) ?? "";

  return { branch, status, recent };
}

// A shallow snapshot of the project's files (respecting walk's skip list), capped
// so the prompt stays small. Gives the model a sense of layout before it explores.
export function dirSnapshot(cwd: string, limit = 40): string {
  let files: string[];
  try {
    files = walkFiles(cwd);
  } catch {
    return "";
  }
  if (files.length === 0) return "";
  files.sort();
  const shown = files.slice(0, limit);
  const more = files.length > limit ? `\n… (+${files.length - limit} more files)` : "";
  return shown.join("\n") + more;
}
