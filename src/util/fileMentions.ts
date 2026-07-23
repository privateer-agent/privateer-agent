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
const IGNORE_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

/**
 * List up to `limit` files/dirs inside cwd whose path matches `query` — the text the
 * user typed after `@`. A query with a trailing "/" (or ending at a real dir) lists
 * that directory's contents; otherwise it prefix-matches the basename within the
 * query's parent dir. Case-insensitive. CWD-constrained: a query that escapes cwd
 * returns nothing.
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
    return [];
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
