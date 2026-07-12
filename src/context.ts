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
        return { path, content: readFileSync(path, "utf-8") };
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

// Format the discovered files into a system-prompt fragment using the same framing Pi
// applies to AGENTS.md (see core/system-prompt.js), so the model can't tell the two
// apart. Returns "" when there's nothing to inject.
export function contextBlock(cwd: string = process.cwd()): string {
  const files = discoverContextFiles(cwd);
  if (files.length === 0) return "";
  let out = `\n\n${CONTEXT_BLOCK_MARKER}\n<project_context>\n\nProject-specific instructions and guidelines:\n\n`;
  for (const { path, content } of files) {
    out += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
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
type Listener = () => void;
const listeners = new Set<Listener>();

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
