// The `save_to_library` tool — put a file from disk into the user's Privateer
// account, where it lives beside everything else they own and reaches every
// device they have signed in.
//
// The interesting part is not this file, it's why the save is a round trip
// through the app at all — src/remote/librarySave.ts has that (short version:
// the terminal holds no master key, and every Library row is ciphertext). What
// matters here is the shape that follows from it:
//
// TAKES A PATH, NOT CONTENT. Same call save_cargo makes, and here it isn't even
// close: a file may be 25 MB, and no amount of it belongs in a tool call. The
// model WRITES the file with its ordinary tools — or generates it, which is the
// common case, since every generate_* tool already names an output path — and
// passes that path. The two compose without either knowing about the other:
// generate_image writes a PNG, save_to_library puts it in the user's pocket.
//
// DOES NOT CHOOSE WHERE IT LANDS, AND SAYS SO. There is deliberately no
// `destination: 'local' | 'cloud'` parameter, and adding one would be a
// privacy bug rather than a feature. Whether an account's files live on its
// device or in our cloud is a setting the person owns (treeview CLAUDE.md §2);
// a terminal that could override it could put bytes on our servers for someone
// who chose device-only storage. So the app decides from the account, and this
// tool REPORTS which one happened — the success line names it, so the model can
// tell the user where their file actually is without ever having picked.
//
// Which SHELF it lands on is the app's call for a smaller reason: the app
// classifies a file the same way it classifies one the user drags in, and a
// second table on this side would drift into filing a generated PNG under
// Documents. The result names the shelf so the model can say where to look.
//
// SAYS WHAT DID AND DIDN'T TRAVEL. Like save_cargo and unlike the generate_*
// tools, this is genuinely end-to-end encrypted: the app encrypts before the
// upload and the server stores ciphertext it cannot read. A model that can't
// tell the two apart will describe generation with this one's guarantees, so
// the description states it plainly and the success line repeats it.

import { Type } from "typebox";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import {
  MAX_LIBRARY_SAVE_BYTES,
  libraryMediaTypeForPath,
  type LibrarySaveRequest,
  type LibrarySaveResult,
} from "../remote/librarySave.ts";

function text(t: string) {
  return { content: [{ type: "text", text: t }], details: {} };
}

/** The bridge surface this tool needs; RemoteBridge implements it. */
export interface LibrarySaveBridge {
  saveToLibraryRemote(req: LibrarySaveRequest, signal?: AbortSignal): Promise<LibrarySaveResult>;
}

export const LIBRARY_TOOL_NAMES = ["save_to_library"] as const;

/** Where the app filed it, in the words the app's own navigation uses. */
const SHELF_LABEL: Record<string, string> = {
  image: "Images",
  video: "Videos",
  audio: "Audio",
  model3d: "Models",
  document: "Documents",
};

export function makeSaveToLibraryTool(bridge: LibrarySaveBridge) {
  return {
    name: "save_to_library",
    label: "Save to Library",
    description:
      "Save a file from disk into the user's Privateer account, so it appears in their Library on every " +
      "device they're signed in on rather than only in this working directory. Use whenever the user asks " +
      "to KEEP something you made or found — an image, a video, an audio clip, a 3D model, a report, a " +
      "spreadsheet. Write or generate the file first with your normal tools and pass its path.\n" +
      "Handles images (png/jpg/gif/webp), video (mp4/mov/webm), audio (mp3/wav/m4a/aac/ogg/flac), 3D " +
      "models (glb/obj/fbx/usdz) and documents (pdf, docx, csv, and text or code files). Each lands on the " +
      "matching shelf in the Library — you don't choose which, and the result tells you where it went so " +
      "you can say. Max 25 MB; a bigger file, or a format not in that list, can still be handed over with " +
      "send_file_to_client, which shows it on the user's device without filing it.\n" +
      "You also do NOT choose whether it goes to the cloud or stays on the device — that follows the " +
      "user's own storage setting, and the result reports which one happened. Say what it reports; don't " +
      "assume cloud.\n" +
      "Needs the Privateer app attached to this terminal: the app holds the key, and it encrypts the file " +
      "on the device before storing it, so the contents are never readable by the server. That is a " +
      "stronger guarantee than the generate_* tools have — do not describe those the same way.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path of the file to save, relative to cwd or absolute (e.g. 'out/cover.png').",
      }),
      name: Type.Optional(
        Type.String({
          description:
            "Name to file it under in the Library, WITH its extension. Say what the thing is, the way the " +
            "user would name it ('Q3 Expenses.csv', 'Harbour at dusk.png') — not a build path. Defaults to " +
            "the file's own name, which is usually worse.",
        }),
      ),
      note: Type.Optional(
        Type.String({
          description:
            "One line on where it came from — the prompt that drew it, the command that produced it. " +
            "Stored encrypted alongside the file. Not a title: the Library titles the row from `name`.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { path: string; name?: string; note?: string },
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: { cwd?: string },
    ) {
      if (!params.path) return text("Error: path is required — say which file to save.");
      const cwd = ctx?.cwd ?? process.cwd();
      const target = isAbsolute(params.path) ? params.path : resolve(cwd, params.path);

      if (!existsSync(target)) return text(`File not found: ${params.path}`);
      const stat = statSync(target);
      if (stat.isDirectory()) return text(`${params.path} is a directory — save a single file.`);
      if (stat.size === 0) return text(`${params.path} is empty — nothing to save.`);
      if (stat.size > MAX_LIBRARY_SAVE_BYTES) {
        return text(
          `${params.path} is ${(stat.size / 1048576).toFixed(1)} MB; saving to the library caps at ` +
            `${MAX_LIBRARY_SAVE_BYTES / 1048576} MB. Use send_file_to_client to hand it to the user's device instead.`,
        );
      }

      // The NAME decides the shelf, not the path — the app classifies on the name,
      // and the name is what the user will see. So the extension has to survive a
      // rename, and a model asked for a human title will reliably drop it: told to
      // name a file the way the user would, it answers 'Q3 Expenses', not
      // 'Q3 Expenses.csv'. Borrowing the source file's extension is the honest
      // repair — it keeps the name the model chose AND the type the bytes actually
      // are. Refusing instead would reject a request that is right about everything
      // that matters, and dropping the name silently would have the model tell the
      // user about a file called something it isn't.
      const named = params.name?.trim();
      const fileName = named ? (extname(named) ? named : named + extname(target)) : basename(target);
      const mediaType = libraryMediaTypeForPath(fileName);
      if (!mediaType) {
        const ext = extname(fileName);
        return text(
          `${fileName} can't go in the library: ${ext || "a file with no extension"} isn't a format it holds. ` +
            `The library holds images (png/jpg/gif/webp), video (mp4/mov/webm), audio (mp3/wav/m4a/aac/ogg/flac), ` +
            `3D models (glb/obj/fbx/usdz) and documents (pdf, docx, csv, text and code files). ` +
            `To put any other file on the user's device, use send_file_to_client.`,
        );
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(target);
      } catch (e) {
        return text(`Couldn't read ${params.path}: ${(e as Error).message}`);
      }

      const res = await bridge.saveToLibraryRemote(
        {
          base64: bytes.toString("base64"),
          size: bytes.length,
          name: fileName,
          mediaType,
          note: params.note?.trim() || undefined,
        },
        signal,
      );

      if (!res.ok) return text(`Couldn't save ${fileName} to the library: ${res.reason}`);

      const shelf = SHELF_LABEL[res.shelf] ?? res.shelf;
      const where =
        res.storageType === "local"
          ? "It is stored on this account's device, which is where this account keeps its files — it is not on our servers"
          : "It went to the account's cloud storage, encrypted on the device first, so the server holds only ciphertext";
      return text(
        `Saved "${res.name}" to the Library under ${shelf} (${(res.bytes / 1024).toFixed(0)} KB). ` +
          `${where}. The user can open, download and share it from the Library in the Privateer app.`,
      );
    },
  };
}
