// The wire contract for CLI → app Library saves, shared by the modules that have
// to agree on it: RelayClient (sends the frames), RemoteBridge (correlates the
// reply), and the save_to_library tool (validates before either runs).
//
// WHY THE ROUND TRIP EXISTS AT ALL. The same reason save_cargo's does, and the
// argument is worth restating because this path moves bytes rather than text and
// the temptation to "just upload it" is correspondingly stronger. Everything in
// the Library is ciphertext under the account master key — the picture, the
// clip, the mesh, the document, and the filename and mime type sealed beside
// them (treeview CLAUDE.md §5). The terminal deliberately holds no master key:
// the device-grant login mints a session token and nothing else, and
// crypto/accountVerify.ts says so out loud. So a CLI that POSTed
// /api/chat/upload-file by itself could only put bytes on S3 that nothing can
// ever open, and a row pointing at them that nothing can ever read.
//
// The app can. It is already signed in, already holds the key, and already has
// the per-shelf save functions the Library's own screens call. So the CLI hands
// it plaintext bytes over the relay the user already trusts to carry their
// prompts and their approvals, and the app does the encrypting.
//
// WHY THE APP ALSO PICKS THE SHELF AND THE BACKEND. Two decisions travel with
// the key, and neither is the terminal's to make:
//
//  - WHICH SHELF. An image belongs in Images, a clip in Audio, a mesh in Models,
//    a report in Documents — each with its own registration route and its own
//    on-device index. The app routes by the same classifier a dragged-in file
//    goes through (client/utils/webFileDrop.ts), so an agent-saved file and a
//    hand-dropped identical file land in the same place. A table on this side
//    would be the second copy, and the drift would show up as the user's
//    generated PNG filed under Documents.
//  - CLOUD OR ON DEVICE. This is the one the tool's name invites a model to
//    guess at, and it must never be a parameter. `resolveStorageBackend()`
//    answers it from the account: a local-backend account's files live on the
//    device and nothing reaches the server (CLAUDE.md §2). A terminal able to
//    override that could put bytes on our servers for an account that chose
//    device-only storage. The tool therefore takes no destination argument and
//    REPORTS which one was used, rather than asking for one.
//
// WHAT THAT COSTS. The app has to be attached. A harbor is headless by design
// and there is no controller to ask, so save_to_library is not registered there —
// an unattended run still delivers a file the way it always has, as a sealed
// attachment on its Inbox result (routines/resultMedia.ts). Don't "fix" that by
// widening this.

/** Which Library shelf the app filed a save on. Mirrors AgentSaveShelf app-side. */
export const LIBRARY_SHELVES = ["image", "video", "audio", "model3d", "document"] as const;
export type LibraryShelf = (typeof LIBRARY_SHELVES)[number];

/**
 * Ceiling on a save, in bytes — the plaintext file, before base64.
 *
 * Matches MAX_AGENT_SAVE_BYTES app-side (client/services/agentLibrarySave.ts),
 * and the number is a WIRE decision rather than a storage one: these bytes cross
 * a relay a phone may be holding over a mobile connection, inflated by a third
 * and cut into 256 KB frames. Checked HERE as well as there, because a refusal
 * that costs nothing to compute should not cost a 33 MB upload first — and
 * because refusing on this side is the only way the message can name the file.
 *
 * Per-shelf server limits still apply UNDER this (an image caps at 10 MB) and
 * are deliberately NOT restated: they live in services/ImageUpload.js, the app
 * surfaces whatever the route says, and a copy here would be a third number to
 * keep in step.
 */
export const MAX_LIBRARY_SAVE_BYTES = 25 * 1024 * 1024;

/**
 * Base64 characters of file per `library_chunk` frame.
 *
 * Same figure the file-send path uses and for the same reason: the relay caps a
 * frame at 256 KB, and 3/4 of that leaves room for the frame's own JSON. Base64
 * rather than raw bytes because the relay carries JSON text — a Library save may
 * be a PNG or a GLB, so unlike a Cargo artifact there is nothing to be gained by
 * sending the payload as a string.
 */
export const LIBRARY_CHUNK_CHARS = 180_000;

/** A CLI-initiated Library save, relayed to the app to encrypt, file and store. */
export interface LibrarySaveRequest {
  /** File bytes, base64. */
  base64: string;
  /** Plaintext byte length, so the app can refuse before reassembling. */
  size: number;
  /** The name to file it under — the user's vocabulary, not a path. */
  name: string;
  mediaType: string;
  /**
   * Free-text provenance sealed into the row's encrypted metadata — the prompt
   * that drew it, the command that produced it. Optional, and never a title:
   * the Library titles a row from `name`.
   */
  note?: string;
}

/**
 * The app's answer. `ok: false` carries a reason written for a person — a locked
 * vault, full cloud storage, a guest session, a file type with no shelf —
 * because the tool hands it straight to the model, and "save failed" is not
 * something it can act on.
 *
 * `storageType` on the success arm is the point of the whole feature being
 * REPORTED rather than requested: it is how the model learns whether the file
 * went to the account's cloud or stayed on the device, so it can tell the user
 * the truth about where their file is without ever having chosen.
 */
export type LibrarySaveResult =
  | { ok: true; shelf: LibraryShelf; storageType: "cloud" | "local"; name: string; bytes: number }
  | { ok: false; reason: string };

/**
 * Media type for a path, by extension. Deliberately a SUPERSET of the send-file
 * table (tools/sendFile.ts): that one types a file for presentation in a feed,
 * where an unknown extension falling to application/octet-stream costs nothing.
 * Here the mime is one of the two things the app classifies on, so a .glb typed
 * as octet-stream would still reach the mesh shelf (matched on extension) but a
 * .txt typed that way would reach no shelf at all and be refused.
 *
 * Returns null rather than a fallback when the extension is unknown, so the tool
 * can say which formats have a shelf instead of sending bytes the app will
 * bounce.
 */
const LIBRARY_MEDIA: Record<string, string> = {
  // Stills. Narrower than what the app calls an image elsewhere, because the
  // upload route filters on the EXTENSION even for client-encrypted bodies —
  // a HEIC is rejected at the door however well the device decodes it.
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  // Video.
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", m4v: "video/x-m4v",
  // Audio.
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
  ogg: "audio/ogg", flac: "audio/flac",
  // 3D. Matched app-side on the extension rather than this mime, but a mime is
  // still sent so the stored metadata says something true.
  glb: "model/gltf-binary", obj: "text/plain", fbx: "application/octet-stream",
  usdz: "model/vnd.usdz+zip",
  // Documents.
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  csv: "text/csv",
  // Text and code, all of which the app files as its `code` document type.
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown",
  json: "application/json", yaml: "text/yaml", yml: "text/yaml", xml: "text/xml",
  html: "text/html", css: "text/css", sql: "text/plain",
  js: "text/javascript", ts: "text/plain", tsx: "text/plain", jsx: "text/plain",
  py: "text/plain", rb: "text/plain", go: "text/plain", rs: "text/plain",
  java: "text/plain", kt: "text/plain", swift: "text/plain", c: "text/plain",
  cpp: "text/plain", h: "text/plain", cs: "text/plain", php: "text/plain",
  sh: "text/plain",
};

export function libraryMediaTypeForPath(p: string): string | null {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return LIBRARY_MEDIA[ext] ?? null;
}

/** The extensions that have a shelf, for a refusal that tells the model what to do. */
export const LIBRARY_EXTENSIONS = Object.keys(LIBRARY_MEDIA);
