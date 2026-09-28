// Privateer co-authors the commits it makes. When the agent runs `git commit` through
// its shell tool, the command is rewritten to carry
//
//   --trailer 'Co-authored-by: Privateer <291203302+privateer-first-mate@users.noreply.github.com>'
//
// so a pushed commit shows Privateer beside the user on GitHub. The account is
// github.com/privateer-first-mate — a real USER account. The `privateer-agent` GitHub
// account is an organization, and an org has no commit email, so a trailer naming it
// would never link or show an avatar.
//
// Why the flag and not a prompt instruction: a model told to add a trailer forgets, or
// adds it to one commit of three. A rewrite in the tool_call hook (makePermissionGate —
// the one hook every surface runs bash through) cannot be skipped, and because it runs
// BEFORE the gate decides, the approval prompt shows the command that will really run.
//
// What is and isn't rewritten:
//   - only `git [global opts] commit` at the START of a shell command (start of string,
//     or after ; & | ( or a newline). `git commit-tree`/`commit-graph` are not commits.
//   - never inside quotes: `-m "fix the git commit hook"` is message text, not a command.
//   - never twice: a command already naming privateer-first-mate is left alone, and on
//     `--amend` git's default trailer.ifExists (addIfDifferentNeighbor) won't duplicate
//     a trailer that is already the last one.
//   - never on git older than 2.32, which has no --trailer and would fail the commit.
//
// Off switch: PRIVATEER_COAUTHOR=0 (or off/false), or `"coauthor": false` in
// ~/.privateer/config.json.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { configPath } from "../config/paths.ts";

export const COAUTHOR_TRAILER =
  "Co-authored-by: Privateer <291203302+privateer-first-mate@users.noreply.github.com>";

const SHELL_TOOLS = new Set(["bash", "shell", "run", "exec", "sh"]);

// `git`, then any global options (`-C dir`, `-c k=v`, `--no-pager`, `--git-dir=x`),
// then `commit` as a whole word — not `commit-tree`, not `commitish`.
const GIT_COMMIT =
  /(^|[;&|(\n])(\s*)(git(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=(?:"[^"]*"|'[^']*'|\S+))?))*\s+commit)(?=\s|$|[;&|)])/g;

/** Positions in `s` that are inside a single- or double-quoted string. */
function quotedMask(s: string): boolean[] {
  const mask = new Array<boolean>(s.length).fill(false);
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      mask[i] = true;
      if (c === "\\" && quote === '"') {
        if (i + 1 < s.length) mask[++i] = true;
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === "\\") {
      i++; // an escaped character outside quotes starts nothing
    } else if (c === "'" || c === '"') {
      quote = c;
      mask[i] = true;
    }
  }
  return mask;
}

/** `command` with the co-author trailer added to every `git commit` in it. */
export function withCoauthorTrailer(command: string): string {
  if (!command.includes("commit") || command.includes("privateer-first-mate")) return command;
  const mask = quotedMask(command);
  const flag = ` --trailer '${COAUTHOR_TRAILER}'`;
  return command.replace(GIT_COMMIT, (match, lead: string, space: string, git: string, offset: number) => {
    const start = offset + lead.length + space.length;
    if (mask[start] || mask[start + git.length - 1]) return match;
    return `${lead}${space}${git}${flag}`;
  });
}

let gitSupportsTrailer: boolean | undefined;

/** git >= 2.32 (the release that added `commit --trailer`). Probed once per process. */
function trailerSupported(): boolean {
  if (gitSupportsTrailer !== undefined) return gitSupportsTrailer;
  try {
    const out = execFileSync("git", ["--version"], { encoding: "utf8", timeout: 5_000 });
    const m = /(\d+)\.(\d+)/.exec(out);
    gitSupportsTrailer = !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 32));
  } catch {
    gitSupportsTrailer = false;
  }
  return gitSupportsTrailer;
}

function coauthorEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.PRIVATEER_COAUTHOR?.trim().toLowerCase();
  if (flag === "0" || flag === "off" || flag === "false") return false;
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"))?.coauthor !== false;
  } catch {
    return true;
  }
}

/**
 * The tool_call side: rewrite a shell tool's command in place (Pi executes the
 * mutated `event.input`). Never throws — a failure here must not block a tool call.
 */
export function coauthorGitCommits(toolName: string, input: unknown, env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (!SHELL_TOOLS.has(toolName.toLowerCase()) || !input || typeof input !== "object") return;
    const obj = input as Record<string, unknown>;
    const key = (["command", "cmd", "script"] as const).find((k) => typeof obj[k] === "string");
    if (!key) return;
    const command = obj[key] as string;
    const next = withCoauthorTrailer(command);
    if (next === command || !coauthorEnabled(env) || !trailerSupported()) return;
    obj[key] = next;
  } catch {
    // leave the command as the model wrote it
  }
}
