// The wire contract for CLI → app Cargo saves, shared by the three modules that
// have to agree on it: RelayClient (sends the frames), RemoteBridge (correlates
// the reply), and the save_cargo tool (validates before either runs).
//
// WHY THE ROUND TRIP EXISTS AT ALL. A Cargo row is `encryptedContent` +
// `encryptedMetadata` — AES-256-GCM, done on the device, under the account master
// key. The server stores ciphertext and never decrypts (treeview CLAUDE.md §5).
// The terminal deliberately holds no master key: the device-grant login mints a
// session token and nothing else, and crypto/accountVerify.ts says so out loud —
// "the terminal holds no master key and can't derive the real one itself". So a
// CLI that POSTed /api/cargo by itself could only write a row nothing can open.
//
// The app can. It is already signed in, already holds the key, and already has
// `saveCargo()` — the same function the chat's Save button and the file importer
// call. So the CLI hands it plaintext over the relay the user already trusts to
// carry their prompts and approvals, and the app does the encrypting. The master
// key stays exactly where it was; the artifact takes the same path to storage a
// model-authored one does. Nothing new reaches the server, and no new endpoint
// exists.
//
// WHAT THAT COSTS. The app has to be attached. A harbor is headless by design and
// there is no controller to ask, so save_cargo is not registered there — an
// unattended run still delivers an artifact the way it always has, as a fence in
// its Inbox result (routines/resultBrief.ts). Don't "fix" that by widening this.

/** Cargo artifact kinds — mirrors client/utils/cargoKinds.ts CargoKind. */
export const CARGO_KINDS = ["webpage", "slides", "game", "pdf", "docx", "md", "sheet"] as const;
export type CargoKind = (typeof CARGO_KINDS)[number];

export function isCargoKind(v: unknown): v is CargoKind {
  return typeof v === "string" && (CARGO_KINDS as readonly string[]).includes(v);
}

/** Kinds whose stored content is a runnable HTML document. */
const HTML_KINDS: readonly CargoKind[] = ["webpage", "slides", "game"];

export const isHtmlKind = (k: CargoKind): boolean => HTML_KINDS.includes(k);

// The artifact's `langs` metadata is deliberately NOT computed here. The app stamps it
// at save time (RemoteDriveContext, the same expression fileImportService uses), because
// it has to match what extractRunnableCode stamps for a model-authored artifact exactly —
// and a second copy on this side of the wire is precisely the drift that would make a
// terminal-authored artifact render differently from an identical one built in chat.

/**
 * The kind implied by a file extension, for when the caller didn't say. Only the
 * unambiguous ones map: .html could be a page, a deck or a game and the model is
 * the one that knows which, so it lands on 'webpage' and is told to say if it
 * meant otherwise. Returns null when the extension isn't one Cargo can hold —
 * the tool refuses rather than guessing, because a .png "saved as a webpage" is
 * a broken artifact the user only discovers when they open it.
 */
export function kindForExtension(ext: string): CargoKind | null {
  switch (ext.toLowerCase()) {
    case ".html":
    case ".htm":
      return "webpage";
    case ".md":
    case ".markdown":
      return "md";
    case ".csv":
      return "sheet";
    default:
      return null;
  }
}

/**
 * Ceiling on the artifact source, matching the app's own MAX_DOC_BYTES
 * (client/utils/extractRunnableCode.ts:46). An artifact arriving from the
 * terminal lands in the same store and the same preview surfaces as a
 * model-authored one, so anything the app would refuse from the model has to be
 * refused here too — and refused HERE, where the message can name the file and
 * its size, rather than as a save failure three frames later.
 */
export const MAX_CARGO_BYTES = 512 * 1024;

/**
 * Characters of artifact text per `cargo_chunk` frame. The relay caps a frame at
 * 256 KB and an artifact may be twice that, so the content is chunked the same
 * way sendFile chunks a file. Text, not base64: a Cargo artifact is HTML,
 * markdown or CSV by definition, so there is nothing binary to encode and the
 * 4/3 inflation would buy nothing. Splitting mid-surrogate is safe — JSON.stringify
 * escapes a lone surrogate as \udXXX and JSON.parse restores it, so the halves
 * rejoin into the original pair on the app side.
 */
export const CARGO_CHUNK_CHARS = 120_000;

/** A CLI-initiated Cargo save, relayed to the app to encrypt and store. */
export interface CargoSaveRequest {
  /** Artifact source: an HTML document, markdown, or CSV per `kind`. */
  content: string;
  kind: CargoKind;
  /** Title for the artifact. Omitted → the app derives one from the content. */
  title?: string;
}

/**
 * The app's answer. `ok: false` carries a reason written for a person — a locked
 * vault, full cloud storage, a guest session — because the tool hands it
 * straight to the model, and "save failed" is not something it can act on.
 */
export type CargoSaveResult =
  | { ok: true; cargoId: string; title: string; storageType: string }
  | { ok: false; reason: string };
