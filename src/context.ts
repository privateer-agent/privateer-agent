// PRIVATEER.md — Privateer's own project-context file, loaded like AGENTS.md / CLAUDE.md.
//
// Pi's built-in context loader only recognizes AGENTS.md and CLAUDE.md (the candidate
// list is hardcoded in the upstream resource-loader and isn't extensible via a hook).
// Rather than patch node_modules, we discover PRIVATEER.md ourselves and inject its
// contents into the system prompt from the privateer-context extension — using the
// exact <project_context>/<project_instructions> framing Pi uses for AGENTS.md, so the
// model treats a PRIVATEER.md indistinguishably from a native context file.
//
// Discovery mirrors Pi's loadProjectContextFiles: the global agent dir first, then every
// ancestor directory from the filesystem root down to cwd (nearest-wins ordering, deeper
// files last so they can refine broader ones). All matches are concatenated.
//
// This module is pure (no Pi imports) so both the injection extension and the brand
// banner can share it. The onContextChanged / emitContextChanged pair lets /init poke the
// banner to re-render its "PRIVATEER.md loaded" line without either extension reaching
// into the other — the same listener idiom as priv.onSignedIn in the auth module.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PRIVATEER_MD = "PRIVATEER.md";

// Case variants we accept on disk (matches Pi's AGENTS.md / AGENTS.MD tolerance).
const CANDIDATES = ["PRIVATEER.md", "PRIVATEER.MD"];

export interface ContextFile {
  path: string;
  content: string;
  bytes: number; // full size on disk, before any budget is applied
}

// ── per-turn context budget ──────────────────────────────────────────────────
//
// A project-context file is not read once. It is re-sent, in full, inside the system
// prompt of EVERY turn — so its size is not a one-off cost, it is a per-tool-call tax on
// latency and on price. That is invisible from the outside, and it does not stay small on
// its own: a PRIVATEER.md accretes changelogs and retired build notes until it is a
// design document.
//
// Measured, and the reason this cap exists: a 117 KB PRIVATEER.md in a game project put
// ~34,000 tokens into every request. On the confidential routes (Phala, Tinfoil, NEAR)
// there is no prompt cache to read them back out of — an enclave answers statelessly — so
// all 34,000 were re-processed from scratch on each of the 121 tool calls in a single
// turn. The turn took 17 minutes, nearly all of it time-to-first-token.
//
// So: load the head of an oversized file and tell the model, in the block itself, where
// the rest is. Truncation is loud (the banner and /context both say so) and it is
// defeatable (PRIVATEER_CONTEXT_MAX_BYTES=off) — but the default has to be a number,
// because the failure mode is a user who never learns why their agent got slow.
export const DEFAULT_CONTEXT_MAX_BYTES = 32 * 1024; // ~8k tokens per turn
export const CONTEXT_MAX_BYTES_ENV = "PRIVATEER_CONTEXT_MAX_BYTES";

// Never cut below this, whatever the env says — a cap small enough to amputate the first
// heading is worse than no cap at all.
const MIN_CONTEXT_MAX_BYTES = 2 * 1024;

/** The per-file byte budget: the env override when it parses, else the default. */
export function contextMaxBytes(): number {
  const raw = (process.env[CONTEXT_MAX_BYTES_ENV] ?? "").trim().toLowerCase();
  if (raw === "") return DEFAULT_CONTEXT_MAX_BYTES;
  if (raw === "off" || raw === "false" || raw === "0" || raw === "none") {
    return Number.POSITIVE_INFINITY; // opt out: load whatever is on disk
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONTEXT_MAX_BYTES; // typo → default
  return Math.max(n, MIN_CONTEXT_MAX_BYTES);
}

/** Rough token count for a byte size. ~4 bytes/token is close enough to budget with. */
export function estimateTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

export interface BudgetedFile extends ContextFile {
  loaded: string; // what actually goes into the prompt (the head, plus a footer, if cut)
  loadedBytes: number; // size of the file's own content in `loaded`, footer excluded
  truncated: boolean;
}

// Cut at a line boundary inside the budget so the model never sees half a sentence, and
// keep the head rather than the tail: a context file opens with what the project IS.
function budgetFile(file: ContextFile, max: number): BudgetedFile {
  if (file.bytes <= max) {
    return { ...file, loaded: file.content, loadedBytes: file.bytes, truncated: false };
  }
  const head = Buffer.from(file.content, "utf-8").subarray(0, max).toString("utf-8");
  const lastBreak = head.lastIndexOf("\n");
  const kept = lastBreak > max / 2 ? head.slice(0, lastBreak) : head;
  const keptBytes = Buffer.byteLength(kept, "utf-8");
  const footer =
    `\n\n[Privateer loaded the first ${fmtBytes(keptBytes)} of this ${fmtBytes(file.bytes)} file. ` +
    `A project-context file is re-sent to the model on EVERY turn, so the rest was left ` +
    `out to keep turns fast — read ${file.path} directly if you need what is missing, and ` +
    `tell the user the file is worth splitting.]`;
  return { ...file, loaded: kept + footer, loadedBytes: keptBytes, truncated: true };
}

/** Human byte size for prompts, the banner and /context. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ContextStats {
  files: BudgetedFile[];
  diskBytes: number; // what is on disk across every discovered file
  loadedBytes: number; // what actually reaches the model each turn
  truncated: boolean; // at least one file was cut
  maxBytes: number; // the budget in force
}

/** Discovery + budget in one call — what the banner and /context both report on. */
export function contextStats(cwd: string = process.cwd()): ContextStats {
  const max = contextMaxBytes();
  const files = discoverContextFiles(cwd).map((f) => budgetFile(f, max));
  return {
    files,
    diskBytes: files.reduce((n, f) => n + f.bytes, 0),
    loadedBytes: files.reduce((n, f) => n + f.loadedBytes, 0),
    truncated: files.some((f) => f.truncated),
    maxBytes: max,
  };
}

// The global agent dir the launcher points Pi at (PRIVATEER_HOME/agent). We read the
// same PI_CODING_AGENT_DIR env the launcher exports so a global ~/.privateer/agent/
// PRIVATEER.md is honored just like a global AGENTS.md; fall back for `npm start`/dev
// runs that don't go through bin/privateer-tui.
function globalAgentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv) return resolve(fromEnv);
  const home = process.env.PRIVATEER_HOME || join(homedir(), ".privateer");
  return join(home, "agent");
}

function readCandidate(dir: string): ContextFile | null {
  for (const name of CANDIDATES) {
    const path = join(dir, name);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        return { path, content, bytes: Buffer.byteLength(content, "utf-8") };
      } catch {
        // unreadable (perms, races) — skip silently; the model just won't see it.
      }
    }
  }
  return null;
}

// All PRIVATEER.md files that apply to `cwd`, in prompt order: global agent dir first,
// then root→cwd so the nearest (deepest) file lands last. De-duplicated by absolute path
// (the global dir can coincide with an ancestor).
export function discoverContextFiles(cwd: string = process.cwd()): ContextFile[] {
  const files: ContextFile[] = [];
  const seen = new Set<string>();
  const push = (f: ContextFile | null) => {
    if (f && !seen.has(f.path)) {
      files.push(f);
      seen.add(f.path);
    }
  };

  push(readCandidate(globalAgentDir()));

  // Walk cwd → root collecting matches, then reverse so root comes first (matching Pi's
  // ancestorContextFiles.unshift ordering).
  const ancestors: ContextFile[] = [];
  let dir = resolve(cwd);
  const root = resolve("/");
  while (true) {
    const f = readCandidate(dir);
    if (f && !seen.has(f.path)) {
      ancestors.unshift(f);
      seen.add(f.path);
    }
    if (dir === root) break;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  files.push(...ancestors);
  return files;
}

// A unique sentinel opening the injected block, so before_agent_start can no-op if the
// block is already present in the chained system prompt (defensive against re-entrancy).
export const CONTEXT_BLOCK_MARKER = "<!-- privateer:PRIVATEER.md -->";
export const RUNTIME_GUIDELINES_MARKER = "<!-- privateer:runtime-guidelines -->";

export function runtimeGuidelinesBlock(): string {
  return `\n\n${RUNTIME_GUIDELINES_MARKER}\n<environment_guidelines>
- Node.js environment: Node.js (v22+) is guaranteed to be available in Privateer. Prefer \`node -e "..."\` or small Node.js scripts for quick scripting, calculations, or JSON processing instead of assuming \`python\` or \`python3\` is installed.
- Search fallback: If \`rg\` (ripgrep) is missing or returns "command not found", fall back to standard POSIX \`grep -rn <pattern> <path>\` or \`find <path>\`.
- Missing system dependencies: If an essential external tool (e.g. \`git\`, \`python\`, \`rg\`) is missing and needed, check its presence (\`command -v <tool>\`), explain clearly what is missing, and offer to install it using the host package manager (e.g. \`brew install\`, \`xcode-select --install\`, \`winget install\`, \`apt install\`) upon user approval.
- Shell calls share no state: every shell call runs in a fresh subshell rooted at the session's working directory, so a \`cd\` (or a variable, or an activated venv) in one call is gone by the next. Use absolute paths, or move and work in ONE call (\`cd <dir> && <command>\`). Never spend a call on \`cd\` alone.
- Batch your steps: every tool call re-sends the whole conversation to the model, so a chain of one-line calls is far slower and more expensive than the same work combined into fewer calls. Group independent reads, searches and checks into one command; do not build test harnesses, scratch scripts or regression runs that the user did not ask for.
</environment_guidelines>\n`;
}

// Format the discovered files into a system-prompt fragment using the same framing Pi
// applies to AGENTS.md (see core/system-prompt.js), so the model can't tell the two
// apart. Returns "" when there's nothing to inject.
export function contextBlock(cwd: string = process.cwd()): string {
  const { files } = contextStats(cwd);
  if (files.length === 0) return "";
  let out = `\n\n${CONTEXT_BLOCK_MARKER}\n<project_context>\n\nProject-specific instructions and guidelines:\n\n`;
  for (const { path, loaded } of files) {
    out += `<project_instructions path="${path}">\n${loaded}\n</project_instructions>\n\n`;
  }
  out += "</project_context>\n";
  return out;
}

// The starter template `/init` writes. Kept deliberately short and self-explaining — the
// first line tells a reader (and the model) exactly what the file is and how it's used.
export const PRIVATEER_TEMPLATE = `# PRIVATEER.md

Project context for the Privateer agent. Privateer loads this file automatically at
startup (the same way it loads AGENTS.md / CLAUDE.md) and prepends it to the model's
system prompt — so put anything the agent should always know about THIS project here.

## Project

<One or two lines: what this project is and what it does.>

## Conventions

- <Coding style, patterns, and idioms to follow.>
- <Things to avoid.>

## Commands

- build: <command>
- test: <command>
- run: <command>

## Notes for the agent

- <Domain context, gotchas, or constraints worth stating once.>
`;

export interface WriteResult {
  path: string;
  created: boolean; // false when a file was already there and we left it untouched
}

// Write a starter PRIVATEER.md into `dir`, never clobbering an existing one.
export function writeTemplate(dir: string = process.cwd()): WriteResult {
  const path = join(dir, PRIVATEER_MD);
  if (existsSync(path)) return { path, created: false };
  writeFileSync(path, PRIVATEER_TEMPLATE, "utf-8");
  return { path, created: true };
}

// ── change notification ──────────────────────────────────────────────────────
// Lets /init (in the context extension) tell the banner (in the brand extension) that
// PRIVATEER.md state changed, so the header re-renders its loaded/hint line immediately —
// without either extension importing the other. Mirrors priv.onSignedIn.
//
// ⚠️ The listener set CANNOT be plain module state. Pi gives every extension its own jiti
// instance with moduleCache:false, so this module is instantiated once per extension that
// imports it: /init's copy and the banner's copy are different objects, and an emit on one
// never reaches a listener registered on the other — the refresh silently did nothing.
// globalThis is the one thing the two copies share. Same fix, same reason, as the pack
// state in src/updates.ts.
type Listener = () => void;
const LISTENERS = Symbol.for("privateer.context.listeners");
const listeners: Set<Listener> = (((globalThis as any)[LISTENERS] ??= new Set<Listener>()) as Set<Listener>);

export function onContextChanged(fn: Listener): void {
  listeners.add(fn);
}

export function emitContextChanged(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // a stale/broken listener must not break /init.
    }
  }
}
