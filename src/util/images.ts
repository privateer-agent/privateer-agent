import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, extname, basename } from "node:path";

// The model-input modalities Privateer can attach and route on. `text` files are not
// a modality here — they're inlined as plain text (see resolveAttachments), never
// routed — so this union only covers the binary kinds that need a capable model.
export type Modality = "image" | "document" | "audio" | "video";

// Extension → { mediaType, modality }. Drives both detection and the media type we
// hand the provider. Inferred from the extension alone (no magic-byte sniffing).
const MEDIA_TYPES: Record<string, { mediaType: string; modality: Modality }> = {
  ".png": { mediaType: "image/png", modality: "image" },
  ".jpg": { mediaType: "image/jpeg", modality: "image" },
  ".jpeg": { mediaType: "image/jpeg", modality: "image" },
  ".gif": { mediaType: "image/gif", modality: "image" },
  ".webp": { mediaType: "image/webp", modality: "image" },
  ".pdf": { mediaType: "application/pdf", modality: "document" },
  ".mp3": { mediaType: "audio/mpeg", modality: "audio" },
  ".wav": { mediaType: "audio/wav", modality: "audio" },
  ".m4a": { mediaType: "audio/mp4", modality: "audio" },
  ".ogg": { mediaType: "audio/ogg", modality: "audio" },
  ".flac": { mediaType: "audio/flac", modality: "audio" },
  ".mp4": { mediaType: "video/mp4", modality: "video" },
  ".mov": { mediaType: "video/quicktime", modality: "video" },
  ".webm": { mediaType: "video/webm", modality: "video" },
  ".mkv": { mediaType: "video/x-matroska", modality: "video" },
};

// Classify a media type into one of our binary modalities, or null when it's a
// text-like file that should be inlined as plain text rather than attached. Used by
// the relay path (App.tsx) to decide what to do with a file received from the app:
// a null result means "decode and inline the text"; otherwise it's a binary
// attachment the model reads directly.
export function mediaModality(mediaType: string): Modality | null {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "application/pdf") return "document";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  return null;
}

// Text-like extensions whose concrete media type matters to the app (rendering /
// save-as). Everything else in TEXT_EXTS is close enough to text/plain.
const TEXT_MEDIA_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".html": "text/html",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
};

// Media type for a file at `p`, for files sent over the relay to the app: binary
// kinds from MEDIA_TYPES, recognized text kinds as text, else octet-stream (the
// app renders those as a generic file card).
export function mediaTypeForPath(p: string): string {
  const ext = extname(p).toLowerCase();
  const meta = MEDIA_TYPES[ext];
  if (meta) return meta.mediaType;
  const text = TEXT_MEDIA_TYPES[ext];
  if (text) return text;
  return TEXT_EXTS.has(ext) ? "text/plain" : "application/octet-stream";
}

// Magic-byte checks per media type, used to reject placeholder/corrupt files at capture
// time. The motivating case: macOS delivers a drag from a screenshot thumbnail as a
// *file promise*, so the terminal's …/T/drop-XXXXXX/ file can be a 4-byte stub holding
// only the start of the PNG signature (0x89 'P' 'N' 'G') — never the real bytes. Reading
// that into an attachment yields a broken "[Image #n]" the model can't use, so we drop
// it here and leave the raw path in the buffer (a visible signal the capture failed).
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG),
  "image/jpeg": (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.length >= 6 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6)),
  "image/webp": (b) =>
    b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
  "application/pdf": (b) => b.length >= 5 && b.toString("latin1", 0, 5) === "%PDF-",
};

// True when `buf` plausibly holds a real file of `mediaType`. For types with a known
// signature we check it; for the rest (audio/video containers vary too much to sniff
// cheaply) we only reject an empty buffer. The aim is to catch promise stubs and
// zero-byte drops, not to fully validate the format.
export function validateBytes(buf: Buffer, mediaType: string): boolean {
  const check = MAGIC[mediaType];
  return check ? check(buf) : buf.length > 0;
}

export interface ImageDims {
  w: number;
  h: number;
}

// Pull pixel dimensions straight from an image's header, or null when the format
// isn't one we parse (or the header is too short). Cheap header reads only — no
// decode. This drives the provenance shown at drop time so a wrong-but-complete
// capture (e.g. a stale 1412×496 banner where you meant a full-height screenshot)
// is visible before the prompt is sent. Validation already rejected truncated stubs.
export function readImageSize(buf: Buffer, mediaType: string): ImageDims | null {
  try {
    if (mediaType === "image/png") {
      // 8-byte sig + 4-byte length + "IHDR" → width@16, height@20, big-endian.
      if (buf.length < 24) return null;
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (mediaType === "image/gif") {
      if (buf.length < 10) return null;
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    if (mediaType === "image/jpeg") {
      // Walk segments to the first Start-Of-Frame marker, which carries the size.
      let off = 2; // skip SOI (0xFFD8)
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) {
          off++;
          continue;
        }
        const marker = buf[off + 1];
        // SOF0–SOF15 hold the frame size; skip DHT(C4)/JPG(C8)/DAC(CC) which share the range.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { w: buf.readUInt16BE(off + 7), h: buf.readUInt16BE(off + 5) };
        }
        const segLen = buf.readUInt16BE(off + 2);
        if (segLen < 2) return null; // malformed → give up
        off += 2 + segLen;
      }
      return null;
    }
  } catch {
    return null; // short/corrupt header → no dimensions, not fatal
  }
  return null;
}

// Text/code/data files: read-as-text (inlined into the prompt), never attached as a
// binary or routed. Anything not here and not in MEDIA_TYPES is left as literal text.
const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml",
  ".ini", ".env", ".xml", ".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".rb",
  ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh", ".bash", ".zsh",
  ".sql", ".log", ".diff", ".patch", ".lua", ".swift", ".kt", ".scala", ".r", ".pl",
]);

// Upper bound on an inlined text file (bytes). Larger files are left as a path token
// for the agent's read tool rather than dumping the whole thing into the prompt.
const DEFAULT_INLINE_MAX_BYTES = 65_536;

export interface Attachment {
  data: string; // base64-encoded file content
  mediaType: string;
  modality: Modality;
  path: string; // the token as written, for display
  n?: number; // session reference number, when resolved as a "[Kind #n]" chip
  bytes?: number; // decoded size, for the drop-time provenance line
  dims?: ImageDims | null; // pixel dimensions for images we can parse, else null
}

// Back-compat alias: callers that predate multimodal still import AttachedImage.
export type AttachedImage = Attachment;

// The chip a resolved attachment collapses to in the prompt/transcript. The kind
// label is derived from the modality so the user (and the model) can tell them apart.
const CHIP_LABEL: Record<Modality, string> = {
  image: "Image",
  document: "PDF",
  audio: "Audio",
  video: "Video",
};
export function chipFor(att: Pick<Attachment, "modality" | "n">): string {
  return `[${CHIP_LABEL[att.modality]} #${att.n}]`;
}

// Compact, human size: "217 KB", "3.4 MB", "812 B". For provenance lines, not exactness.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// A one-line "what did we actually capture" description for a staged attachment:
// "screenshot.png · 1412×496 · 217 KB". Filename + dimensions + size are exactly the
// signals that expose a wrong-file drop before the prompt is sent.
export function describeAttachment(att: Attachment): string {
  const parts = [basename(att.path)];
  if (att.dims) parts.push(`${att.dims.w}×${att.dims.h}`);
  if (att.bytes != null) parts.push(formatBytes(att.bytes));
  return parts.join(" · ");
}

// A path-like token and the slice of the original text it occupies, so callers can
// substitute it in place (e.g. with a chip) without re-matching the quoted/escaped
// raw form.
interface Span {
  value: string; // unescaped/unquoted token text
  start: number; // inclusive index into the original string
  end: number; // exclusive index into the original string
}

// Split text into path-like spans, honoring the shell-style quoting people reach
// for when a path contains spaces: '"a b.png"', "'a b.png'", and backslash escapes
// ("a\ b.png"). Without this, a pasted path like
//   /Users/me/Screenshot\ 2026.png
// would shatter on whitespace and never match a real file.
function tokenizeSpans(text: string): Span[] {
  const spans: Span[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false; // distinguishes an empty quoted token from no token
  let tokenStart = 0;
  const flush = (end: number) => {
    if (started) spans.push({ value: cur, start: tokenStart, end });
    cur = "";
    started = false;
  };
  const begin = (i: number) => {
    if (!started) {
      tokenStart = i;
      started = true;
    }
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      begin(i);
      quote = ch;
    } else if (ch === "\\" && i + 1 < text.length) {
      begin(i);
      cur += text[++i]; // escaped char joins the token literally
    } else if (/\s/.test(ch)) {
      flush(i);
    } else {
      begin(i);
      cur += ch;
    }
  }
  flush(text.length);
  return spans;
}

function resolvePath(token: string, cwd: string): string {
  return isAbsolute(token) ? token : join(cwd, token);
}

// Read the binary-modality file behind a path-like token (image/document/audio/video),
// or null when the token isn't such a file or can't be read. Capability of the target
// model is the router's concern, not this function's.
function readAttachment(
  token: string,
  cwd: string,
): { data: string; mediaType: string; modality: Modality; abs: string; bytes: number; dims: ImageDims | null } | null {
  const meta = MEDIA_TYPES[extname(token).toLowerCase()];
  if (!meta) return null;
  const abs = resolvePath(token, cwd);
  if (!existsSync(abs)) return null;
  try {
    const buf = readFileSync(abs);
    if (!validateBytes(buf, meta.mediaType)) return null; // promise stub / corrupt → skip
    const dims = meta.modality === "image" ? readImageSize(buf, meta.mediaType) : null;
    return { data: buf.toString("base64"), ...meta, abs, bytes: buf.length, dims };
  } catch {
    return null; // unreadable → skip
  }
}

// Find binary-modality file paths referenced in a prompt (optionally as @mentions) and
// read them as base64 so they can be attached to the model message. Handles quoted and
// backslash-escaped paths with spaces. Tokens that don't resolve to a readable
// image/document/audio/video file are ignored.
export function extractAttachments(text: string, cwd: string): Attachment[] {
  const out: Attachment[] = [];
  const seen = new Set<string>();
  for (const span of tokenizeSpans(text)) {
    const token = span.value.replace(/^@/, "");
    const att = readAttachment(token, cwd);
    if (!att || seen.has(att.abs)) continue;
    out.push({
      data: att.data,
      mediaType: att.mediaType,
      modality: att.modality,
      path: token,
      bytes: att.bytes,
      dims: att.dims,
    });
    seen.add(att.abs);
  }
  return out;
}

// Back-compat: the old image-only entry point.
export const extractImages = extractAttachments;

// Read a text/code/data file for inlining, or null when it isn't a text file, doesn't
// exist, or exceeds the size cap (left for the agent's read tool instead).
function readTextFile(token: string, cwd: string, maxBytes: number): string | null {
  if (!TEXT_EXTS.has(extname(token).toLowerCase())) return null;
  const abs = resolvePath(token, cwd);
  if (!existsSync(abs)) return null;
  try {
    if (statSync(abs).size > maxBytes) return null; // too big → leave the path alone
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

export interface ResolvedAttachments {
  text: string; // prompt with binary paths rewritten to chips and text paths to [file: …]
  attachments: Attachment[]; // image/document/audio/video, each carrying its [Kind #n]
  inlinedText: string; // concatenated contents of any read-as-text files
}

// Rewrite a prompt's referenced files in place: binary-modality paths become stable
// "[Kind #n]" chips (and their base64 is collected as attachments), and recognized
// text/code files are inlined — their path replaced with "[file: name]" and their
// contents appended to `inlinedText`. Chip numbers are assigned from `startSeq` and
// shared across the session; the same file referenced twice reuses its number. Edits
// are applied right-to-left so indices stay valid.
export function resolveAttachments(
  text: string,
  cwd: string,
  startSeq: number,
  inlineMaxBytes: number = DEFAULT_INLINE_MAX_BYTES,
): ResolvedAttachments {
  const spans = tokenizeSpans(text);
  const byAbs = new Map<string, Attachment>(); // abs path → attachment (dedupe)
  const attachments: Attachment[] = [];
  const inlinedParts: string[] = [];
  const inlinedSeen = new Set<string>();
  const edits: { start: number; end: number; replacement: string }[] = [];
  let seq = startSeq;

  for (const span of spans) {
    const token = span.value.replace(/^@/, "");
    const abs = resolvePath(token, cwd);

    const existing = byAbs.get(abs);
    if (existing) {
      edits.push({ start: span.start, end: span.end, replacement: chipFor(existing) });
      continue;
    }

    const att = readAttachment(token, cwd);
    if (att) {
      const resolved: Attachment = {
        data: att.data,
        mediaType: att.mediaType,
        modality: att.modality,
        path: token,
        n: ++seq,
        bytes: att.bytes,
        dims: att.dims,
      };
      byAbs.set(abs, resolved);
      attachments.push(resolved);
      edits.push({ start: span.start, end: span.end, replacement: chipFor(resolved) });
      continue;
    }

    const body = readTextFile(token, cwd, inlineMaxBytes);
    if (body !== null) {
      const name = basename(token);
      if (!inlinedSeen.has(abs)) {
        inlinedSeen.add(abs);
        inlinedParts.push(`--- ${name} ---\n${body}`);
      }
      edits.push({ start: span.start, end: span.end, replacement: `[file: ${name}]` });
    }
  }

  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.replacement + out.slice(e.end);
  }
  return { text: out, attachments, inlinedText: inlinedParts.join("\n\n") };
}
