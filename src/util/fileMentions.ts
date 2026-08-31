// @file mentions — let a prompt reference files on the terminal's machine by typing
// `@path`. Used by BOTH surfaces:
//   • the local REPL (readline tab-completion + resolution at submit)
//   • the app composer, driven over the relay (a files_search palette; the SAME
//     resolution runs on the terminal when the prompt lands)
//
// The mention token stays INLINE in the prompt (so the model sees the reference in
// context) and each referenced file's content is appended after it as a
// <file name="…">…</file> block — text inline, images as real attachments. This
// mirrors Pi's own @file CLI-arg expander (cli/file-processor) but is a library, not
// a process: it never exits on a bad path, and it is CWD-CONSTRAINED.
//
// SECURITY: resolution is a client-side text expansion that bypasses the permission
// gate (unlike the Read tool). A remote driver is the account owner, but a
// gate-bypassing arbitrary read (`@/etc/shadow`, `@../secrets`) is exactly what we
// must not grant. So every token MUST resolve inside cwd — anything that escapes the
// cwd subtree (absolute paths, `..`, symlink targets outside) is skipped, not read.
// The same rule bounds the relay file-search so filenames outside the project never
// leak to the controller.

import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** An image attachment, shaped for AgentSession.prompt()'s `images` option (Pi's ImageContent). */
export interface MentionImage {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface ResolvedMentions {
  /** The prompt with each referenced file's content appended as a <file> block. */
  text: string;
  /** Image attachments to pass via prompt options.images. */
  images: MentionImage[];
  /** cwd-relative paths that were successfully attached. */
  resolved: string[];
  /** Raw tokens that couldn't be attached (missing / outside cwd / a dir / too big). */
  skipped: string[];
}

// Inline text stays reasonable; a giant file would blow the context and the relay.
const MAX_TEXT_BYTES = 256 * 1024; // 256 KB per text file inlined
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image before base64

const IMAGE_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

// Trailing characters that are almost always sentence punctuation, not part of a
// filename — trimmed from a token if the trimmed form resolves and the raw doesn't.
const TRAIL_PUNCT = /[.,;:!?)\]}>]+$/;

// A mention is `@` at start-of-string or after whitespace, then either a "quoted path"
// (allows spaces) or a run of non-whitespace path characters. Capturing group 2 is the
// path (quoted contents via group 3, else the bare run).
const MENTION_RE = /(^|\s)@("([^"]+)"|[^\s@]+)/g;

/** Pull the raw path tokens out of a prompt (order-preserving, de-duplicated). */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    const raw = m[3] ?? m[2]; // quoted contents, else the bare run
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

// Resolve a raw token to an absolute path inside cwd, or null if it escapes / doesn't
// exist. Follows the real (symlink-resolved) path and re-checks containment so a
// symlink inside cwd pointing outside can't be used to read out.
async function resolveInsideCwd(raw: string, cwd: string): Promise<string | null> {
  // A relative path only — an absolute token is an escape attempt by definition.
  if (isAbsolute(raw)) return null;
  const abs = resolve(cwd, raw);
  const within = (p: string): boolean => p === cwd || p.startsWith(cwd + sep);
  if (!within(abs)) return null; // `..` climbed out
  try {
    const real = await realpath(abs);
    // realpath the cwd too, so a symlinked project root still matches.
    const realCwd = await realpath(cwd).catch(() => cwd);
    if (real !== realCwd && !real.startsWith(realCwd + sep)) return null;
    return real;
  } catch {
    return null; // doesn't exist
  }
}

// Try the token as-is, then progressively trimmed of trailing punctuation, returning
// the first form that resolves to a readable file inside cwd.
async function resolveToken(raw: string, cwd: string): Promise<string | null> {
  const candidates = [raw];
  const trimmed = raw.replace(TRAIL_PUNCT, "");
  if (trimmed && trimmed !== raw) candidates.push(trimmed);
  for (const c of candidates) {
    const abs = await resolveInsideCwd(c, cwd);
    if (abs) return abs;
  }
  return null;
}

/**
 * Expand every `@path` mention in `text` into appended <file> blocks (text) plus image
 * attachments. Unresolved mentions are left inline verbatim and reported in `skipped`.
 * The returned `text` equals the input when there are no resolvable mentions.
 */
export async function resolveMentions(text: string, cwd: string): Promise<ResolvedMentions> {
  const tokens = parseMentions(text);
  const images: MentionImage[] = [];
  const resolved: string[] = [];
  const skipped: string[] = [];
  const blocks: string[] = [];
  // resolveToken returns the symlink-resolved (real) absolute path, so relative paths
  // must be computed against the real cwd — otherwise a symlinked cwd (e.g. /var →
  // /private/var on macOS) yields a spurious `../../…` prefix.
  const realCwd = await realpath(cwd).catch(() => cwd);

  for (const raw of tokens) {
    const abs = await resolveToken(raw, cwd);
    if (!abs) { skipped.push(raw); continue; }
    let st;
    try { st = await stat(abs); } catch { skipped.push(raw); continue; }
    if (!st.isFile() || st.size === 0) { skipped.push(raw); continue; }
    const rel = relative(realCwd, abs) || basename(abs);
    const mime = IMAGE_EXT[extOf(abs)];
    try {
      if (mime) {
        if (st.size > MAX_IMAGE_BYTES) { skipped.push(raw); continue; }
        const buf = await readFile(abs);
        images.push({ type: "image", data: buf.toString("base64"), mimeType: mime });
        // A bare reference so the model ties the image to the path it saw inline.
        blocks.push(`<file name="${rel}"></file>`);
      } else {
        if (st.size > MAX_TEXT_BYTES) { skipped.push(raw); continue; }
        const content = await readFile(abs, "utf-8");
        blocks.push(`<file name="${rel}">\n${content}\n</file>`);
      }
      resolved.push(rel);
    } catch {
      skipped.push(raw);
    }
  }

  const out = blocks.length ? `${text}\n\n${blocks.join("\n")}` : text;
  return { text: out, images, resolved, skipped };
}

// ── autocomplete ──────────────────────────────────────────────────────────────────

export interface FileMatch {
  /** cwd-relative path (directories carry a trailing "/"). */
  path: string;
  isDir: boolean;
}

// Directory entries we never surface as suggestions (noise / not project files).
// Pruned from BOTH the single-level listing and the project-wide walk — .git and
// node_modules are where a repo keeps its hundred thousand entries, and a walk that
// descended into them would spend its whole budget before reaching real source.
const IGNORE_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

// Bounds for the project-wide walk behind @-search. A source tree with vendor trees
// pruned (see the .gitignore note below) is a few thousand entries; these caps exist
// so a pathological tree can never turn one keystroke into a disk storm. Whichever
// bound trips first ends the walk — the matches gathered up to that point are ranked
// and returned, so the degrade is "fewer suggestions", never a hang.
const WALK_MAX_ENTRIES = 20_000;
const WALK_MAX_MS = 250;
const WALK_MAX_POOL = 2_000;

// ── .gitignore pruning for the walk ──────────────────────────────
// IGNORE_DIRS alone can't keep the walk inside real source: a repo's heaviest trees
// are often NOT named node_modules — ios/Pods here, android/build, dist, web-build,
// .expo elsewhere. If the walk descended into those, a 20k-entry budget could die in
// one vendor checkout before reaching the first source file (that exact starvation
// is why `@en.json` found nothing while `@screens/…` worked). Every fuzzy finder
// answers this the same way: honor .gitignore. So the walk reads one at EVERY level
// (a nested .gitignore scopes its own subtree — that's what makes ios/.gitignore
// prune Pods), bounded to the common grammar: comments, blank lines, `dir/`,
// anchored `/path`, mid-slash paths, and `*`/`?`/`**` globs. Negations (`!…`) are
// deliberately skipped — full git precedence order is not worth it here, and
// over-ignoring only hides a suggestion (exact drill-down and resolution at submit
// still reach anything).
interface GitPattern { re: RegExp; dirOnly: boolean; anchored: boolean }
interface GitScope { rel: string; pats: GitPattern[]; parent: GitScope | null }

/** Common-grammar .gitignore glob → regex source. Doublestar spans levels at the
 *  three git-defined positions (start of pattern, end, embedded between slashes);
 *  star and question mark never cross a segment. */
function globToRegex(pat: string): string {
  let s = pat;
  if (s.startsWith("**/")) s = "\u0000" + s.slice(3);
  s = s.replace(/\/\*\*\//g, "/\u0000");
  if (s.endsWith("/**")) s = s.slice(0, -2) + "\u0001";
  s = s.replace(/\*\*/g, "*"); // any leftover ** behaves like *
  s = s.split("").map((ch) => {
    if (ch === "*") return "[^/]*";
    if (ch === "?") return "[^/]";
    if ("\\.+^${}()|[]".includes(ch)) return "\\" + ch;
    return ch;
  }).join("");
  return s.replace(/\u0000/g, "(?:[^/]*/)*").replace(/\u0001/g, ".*");
}

function compileGitignore(text: string): GitPattern[] {
  const out: GitPattern[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    let pat = line;
    const dirOnly = pat.endsWith("/");
    if (dirOnly) pat = pat.slice(0, -1);
    let anchored = pat.startsWith("/");
    if (anchored) pat = pat.slice(1);
    if (!anchored && pat.includes("/")) anchored = true; // a mid-slash pattern is rooted, per git
    if (!pat || pat === "*") continue; // "*" would empty the sweep; treat as noise
    out.push({ re: new RegExp(`^${globToRegex(pat)}$`), dirOnly, anchored });
  }
  return out;
}

async function readGitignore(dirAbs: string): Promise<GitPattern[] | null> {
  try {
    return compileGitignore(await readFile(join(dirAbs, ".gitignore"), "utf-8"));
  } catch {
    return null; // none here — the common case
  }
}

/** Is `rel` (cwd-relative) ruled out by any scope in the chain? Each scope's
 *  patterns are tested against the path relative to ITS dir; a non-anchored
 *  pattern matches the entry's own name at any depth. */
function isIgnoredByGitignore(rel: string, isDir: boolean, scope: GitScope | null): boolean {
  for (let s = scope; s; s = s.parent) {
    const relToScope = s.rel ? rel.slice(s.rel.length + 1) : rel;
    const base = relToScope.slice(relToScope.lastIndexOf("/") + 1);
    for (const p of s.pats) {
      if (p.dirOnly && !isDir) continue;
      if (p.anchored ? p.re.test(relToScope) : p.re.test(base)) return true;
    }
  }
  return false;
}

/**
 * Depth-first walk of cwd's subtree, collecting every file and directory as a
 * cwd-relative FileMatch (dirs carry a trailing "/"). IGNORE_DIRS is pruned,
 * .gitignore rules prune vendor/build trees (see the block above), symlinks are
 * listed but NEVER followed (loop + escape), and dotfiles are hidden unless
 * `showHidden`. Bounded by the caps above — see the note on them.
 */
async function walkProject(cwd: string, showHidden: boolean): Promise<FileMatch[]> {
  const pool: FileMatch[] = [];
  const deadline = Date.now() + WALK_MAX_MS;
  const rootPats = await readGitignore(cwd);
  const rootScope: GitScope | null = rootPats ? { rel: "", pats: rootPats, parent: null } : null;
  // An explicit stack rather than recursion: a deep tree can't overflow anything,
  // and the budget checks have one natural place (the loop head). Each pending dir
  // carries the gitignore scope chain in force beneath it, as an immutable
  // parent-linked list — no push/pop bookkeeping to drift out of sync.
  const pending: Array<{ abs: string; rel: string; scope: GitScope | null }> = [{ abs: cwd, rel: "", scope: rootScope }];
  let visited = 0;
  while (pending.length > 0) {
    if (visited >= WALK_MAX_ENTRIES || pool.length >= WALK_MAX_POOL || Date.now() > deadline) break;
    const dir = pending.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue; // unreadable (permissions / vanished) — skip, like a listing would
    }
    // Sorted so the pool order — and therefore any rank tie — is deterministic.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    // A .gitignore in THIS dir scopes everything below it.
    const innerPats = await readGitignore(dir.abs);
    const scope: GitScope | null = innerPats ? { rel: dir.rel, pats: innerPats, parent: dir.scope } : dir.scope;
    for (const e of entries) {
      if (visited >= WALK_MAX_ENTRIES || pool.length >= WALK_MAX_POOL) break;
      visited++;
      if (IGNORE_DIRS.has(e.name)) continue;
      if (e.name.startsWith(".") && !showHidden) continue;
      const isDir = e.isDirectory();
      const rel = dir.rel ? `${dir.rel}/${e.name}` : e.name;
      if (isIgnoredByGitignore(rel, isDir, scope)) continue;
      pool.push({ path: isDir ? `${rel}/` : rel, isDir });
      // Real subdirectories only — a symlink to a dir is surfaced as a dir pick
      // (drill-down resolves it safely) but never walked.
      if (isDir && !e.isSymbolicLink()) pending.push({ abs: join(dir.abs, e.name), rel, scope });
    }
  }
  return pool;
}

/**
 * List up to `limit` files/dirs inside cwd whose path matches `query` — the text the
 * user typed after `@`. Two tiers:
 *
 *   1. Drill-down (exact): the query's own directory, its children filtered by the
 *      basename prefix. `@src/` lists src/; `@src/ut` names src/utils/ first. A
 *      trailing "/" means "I'm browsing HERE" and returns only this tier.
 *   2. Project-wide (fuzzy): the rest of the subtree, at any depth, honoring
 *      .gitignore so vendor/build trees never crowd out — or starve the budget
 *      before — real source. A bare fragment (`@remo`) matches any file/dir NAME
 *      containing it — wherever it lives — and a dir-qualified one (`@src/ut`)
 *      matches whole paths carrying it. Skipped for a one-character fragment, where
 *      a whole-tree sweep is all noise; the drill-down answer is the right one there.
 *
 * Case-insensitive. CWD-constrained: a query that escapes cwd returns nothing, and
 * the walk never leaves the subtree — so no path outside the project can leak.
 */
export async function searchFiles(query: string, cwd: string, limit = 50): Promise<FileMatch[]> {
  const q = query ?? "";
  if (isAbsolute(q)) return [];
  // Split into the directory to scan and the basename prefix to filter by. A trailing
  // slash means "list this dir", so the prefix is empty.
  const endsWithSlash = q.endsWith("/");
  const dirPart = endsWithSlash ? q : dirname(q);
  const prefix = endsWithSlash ? "" : basename(q);
  const scanRel = dirPart === "." ? "" : dirPart;
  const scanAbs = resolve(cwd, scanRel);
  // Containment check (mirror resolveInsideCwd, sync form — no realpath needed for a listing).
  if (scanAbs !== cwd && !scanAbs.startsWith(cwd + sep)) return [];

  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(scanAbs, { withFileTypes: true });
  } catch {
    entries = []; // the dir may not exist — tier 2 below can still search the tree
  }
  const pfx = prefix.toLowerCase();
  const matches: FileMatch[] = [];
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    if (pfx && !e.name.toLowerCase().startsWith(pfx)) continue;
    if (e.name.startsWith(".") && !pfx.startsWith(".")) continue; // hide dotfiles unless asked
    const isDir = e.isDirectory();
    const rel = scanRel ? join(scanRel, e.name) : e.name;
    matches.push({ path: isDir ? `${rel}/` : rel, isDir });
    if (matches.length >= limit) break;
  }
  // Directories first, then alphabetical — the natural drill-down order.
  matches.sort((a, b) => (a.isDir === b.isDir ? a.path.localeCompare(b.path) : a.isDir ? -1 : 1));

  // Tier 2 — the project-wide reach. Off when browsing a dir outright ("src/"), when
  // tier 1 already filled the page, and for a 1-char bare fragment (all noise). A
  // dir-qualified fragment is exempt from the length gate: its match is a whole-path
  // substring, which is already precise at any length ("src/a" hits src/app.ts).
  const dirQualified = dirPart !== ".";
  if (!endsWithSlash && matches.length < limit && (prefix.length === 0 || prefix.length >= 2 || dirQualified)) {
    const pool = await walkProject(cwd, prefix.startsWith("."));
    const ql = q.toLowerCase();
    const seen = new Set(matches.map((m) => m.path));
    const scored: Array<{ m: FileMatch; starts: boolean; depth: number }> = [];
    for (const m of pool) {
      if (seen.has(m.path)) continue;
      seen.add(m.path);
      const bare = m.path.endsWith("/") ? m.path.slice(0, -1) : m.path;
      const name = basename(bare).toLowerCase();
      if (prefix) {
        // A dir-qualified query matches against the whole path ("src/ut" hits
        // src/util/cache.ts, and also another package's src/…); a bare fragment
        // matches the entry's own name, wherever it sits in the tree.
        const hit = dirQualified ? m.path.toLowerCase().includes(ql) : name.includes(pfx);
        if (!hit) continue;
      }
      scored.push({ m, starts: prefix ? name.startsWith(pfx) : false, depth: bare.split("/").length });
    }
    // Relevance: a name that STARTS with the fragment outranks one that merely
    // carries it, then shallower over deeper, then alphabetical. Bare `@` (no
    // fragment) sorts purely shallow-first — a browsable, explorer-style listing.
    scored.sort((a, b) =>
      a.starts !== b.starts ? (a.starts ? -1 : 1)
      : a.depth !== b.depth ? a.depth - b.depth
      : a.m.path.localeCompare(b.m.path),
    );
    for (const s of scored) {
      if (matches.length >= limit) break;
      matches.push(s.m);
    }
  }
  return matches;
}

/**
 * A Node readline completer for `@`-mentions. Given the line up to the cursor, if it
 * ends in an `@token`, returns full-line completions (readline replaces the whole
 * line) so the mention drills into the cwd tree on Tab. Returns [[], line] when the
 * cursor isn't in a mention, leaving other completion untouched.
 */
export async function completeMention(line: string, cwd: string): Promise<[string[], string]> {
  // Find the last unquoted-ish `@token` that runs to the end of the line.
  const m = /(^|\s)@([^\s@]*)$/.exec(line);
  if (!m) return [[], line];
  const token = m[2];
  const tokenStart = m.index + m[1].length; // index of the '@'
  const head = line.slice(0, tokenStart); // everything before '@'
  const matches = await searchFiles(token, cwd, 100);
  // Rebuild each as a full line: head + "@" + path. A single dir match keeps the
  // trailing slash so the next Tab drills in.
  const hits = matches.map((mm) => `${head}@${mm.path}`);
  return [hits, line];
}
