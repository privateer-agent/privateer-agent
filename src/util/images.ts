import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, extname } from "node:path";

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface AttachedImage {
  data: string; // base64-encoded file content
  mediaType: string;
  path: string; // the token as written, for display
}

// Find image file paths referenced in a prompt (optionally as @mentions) and read
// them as base64 so they can be attached to the model message. Tokens without an
// image extension, or that don't resolve to a readable file, are ignored. Provider
// support for vision is assumed by the caller; non-vision models will surface an error.
export function extractImages(text: string, cwd: string): AttachedImage[] {
  const out: AttachedImage[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^@/, "");
    const mediaType = IMAGE_MEDIA_TYPES[extname(token).toLowerCase()];
    if (!mediaType) continue;
    const abs = isAbsolute(token) ? token : join(cwd, token);
    if (seen.has(abs) || !existsSync(abs)) continue;
    try {
      out.push({ data: readFileSync(abs).toString("base64"), mediaType, path: token });
      seen.add(abs);
    } catch {
      /* unreadable → skip */
    }
  }
  return out;
}
