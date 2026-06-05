import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitStatus, dirSnapshot } from "./projectInfo.ts";

// The system prompt is assembled from modular sections: static segments first,
// then a dynamic environment block. Static sections (identity, tone, tool
// policy) come first so they stay byte-stable across turns and cache well; the
// dynamic environment block (cwd, git status, snapshot) comes last. `buildSystemPrompt`
// stays a pure synchronous string builder — the only I/O is reading project files and
// the soft git/dir probes in projectInfo.ts.

const IDENTITY = `You are Privateer, a provider-agnostic terminal coding agent. You help with software \
engineering tasks directly from the user's terminal, with the same working style as a senior \
engineer pairing over a shared shell.`;

const TONE = `Tone and style:
- Be concise and direct. Minimize preamble and postamble — no "Sure!", no "Here is what I'll do" \
unless asked. Let your actions and their results speak.
- Prefer doing over explaining. When a task is clear, use your tools to accomplish it rather than \
describing how the user could.
- Keep prose short. Answer the question that was asked; don't volunteer tangents.
- When you finish a task, stop. Don't summarize work the user just watched you do.`;

const SECURITY = `Security:
- Assist with defensive security, debugging, and legitimate engineering. Refuse to help create or \
improve malware, exploits aimed at systems the user doesn't own, or other clearly malicious uses.
- Never expose or exfiltrate secrets. Don't print API keys or credentials you encounter.`;

const TOOL_POLICY = `Using your tools:
- Explore before you change: use 'glob' to find files by name and 'grep' to search contents. \
Read a file with 'read' before editing it.
- Prefer 'edit' (exact-string replace) over 'write' for changes to existing files; reserve 'write' \
for new files or full rewrites.
- Batch independent reads/searches rather than going one at a time.
- For multi-step work, call 'todo' to lay out and track the plan; keep exactly one item \
in_progress and mark items completed as you finish them. This keeps the user oriented.
- For broad, open-ended search or investigation, delegate to a 'task' sub-agent so the details \
stay out of the main conversation; it returns just a summary.
- Use 'bash' for builds, tests, git, and other CLI work. Avoid long-running or interactive commands.
- Use 'web_fetch' to read a known URL when the user provides one or you need current docs.
- Mutating actions (write/edit/bash) may require user approval; that's expected — proceed and let \
the gate handle it.`;

const PLAN_MODE = `Plan mode is active. Your write, edit, and bash tools are disabled — do not attempt to \
modify files or run commands. Investigate with read, glob, and grep, then present a clear, \
step-by-step implementation plan as your final message. Do not start implementing; wait for the \
user to approve the plan first.`;

export interface SystemPromptOptions {
  cwd: string;
  model: string;
  // Optional output-style body: replaces the default tone/persona section.
  outputStyleBody?: string;
  // When true, append the plan-mode mandate (read-only, produce a plan).
  planMode?: boolean;
}

// System prompt for a `task` sub-agent: same environment grounding, but a read-only,
// report-back mandate. It shares the parent's identity/security stance but swaps the
// tool policy for the restricted subset.
export function buildSubAgentPrompt(opts: SystemPromptOptions & { description: string }): string {
  return [
    IDENTITY,
    SECURITY,
    `You are running as a read-only sub-agent for the task: "${opts.description}".`,
    `You have read, glob, and grep only — you cannot modify files or run commands. Investigate ` +
      `thoroughly and efficiently, then return a concise, self-contained summary of your findings ` +
      `(reference concrete file paths and line numbers). Do not ask the user questions; you run ` +
      `autonomously and your final message is your whole report.`,
    `Environment:\n- cwd: ${opts.cwd}\n- platform: ${process.platform}`,
  ].join("\n\n");
}

// System prompt for a user-defined sub-agent: the agent's own instructions plus the
// shared identity/security stance and an autonomous report-back mandate.
export function buildAgentPrompt(
  opts: SystemPromptOptions & { description: string; instructions: string },
): string {
  return [
    IDENTITY,
    opts.instructions,
    SECURITY,
    `You are running as a sub-agent for the task: "${opts.description}". Work autonomously and ` +
      `return a concise, self-contained final report (reference concrete file paths). Do not ask ` +
      `the user questions — your final message is your whole report.`,
    `Environment:\n- cwd: ${opts.cwd}\n- platform: ${process.platform}`,
  ].join("\n\n");
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  // An active output style replaces the default tone/persona section.
  const persona = opts.outputStyleBody?.trim() || TONE;
  const parts: string[] = [IDENTITY, persona, SECURITY, TOOL_POLICY];
  if (opts.planMode) parts.push(PLAN_MODE);

  // --- Dynamic environment section ---
  const env: string[] = [
    `Environment:`,
    `- cwd: ${opts.cwd}`,
    `- model: ${opts.model}`,
    `- platform: ${process.platform}`,
    `- date: ${new Date().toISOString().slice(0, 10)}`,
  ];

  const git = gitStatus(opts.cwd);
  if (git) {
    env.push(`- git branch: ${git.branch}`);
    env.push(`\nGit status (porcelain):\n${git.status}`);
    if (git.recent) env.push(`\nRecent commits:\n${git.recent}`);
  }

  const snapshot = dirSnapshot(opts.cwd);
  if (snapshot) env.push(`\nProject files (partial):\n${snapshot}`);

  parts.push(env.join("\n"));

  // Project context file, our CLAUDE.md analog. Loaded last so user-authored
  // standing instructions carry the most weight.
  const ctxFile = join(opts.cwd, "PRIVATEER.md");
  if (existsSync(ctxFile)) {
    parts.push(`Project context from PRIVATEER.md:\n${readFileSync(ctxFile, "utf8").trim()}`);
  }

  return parts.join("\n\n");
}
