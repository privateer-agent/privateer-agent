// The `save_cargo` tool — save a file from disk into the user's Privateer app as
// Cargo: a titled, runnable artifact they can open, edit, download and share
// from any of their devices, not a path that only exists on this machine.
//
// The interesting part is not this file, it's why the save goes through the app
// at all — src/remote/cargoSave.ts has that (short version: the terminal holds no
// master key, and a Cargo row is ciphertext). Two routes follow from it: with an
// app attached, a live round trip that comes back with the stored row's id; with
// none, the artifact is sealed to the account and QUEUED for the next app to file.
// What matters here is the shape that follows:
//
// TAKES A PATH, NOT CONTENT. An artifact runs to half a megabyte. Inlining that
// into a tool call would spend the whole thing in tokens, twice — once when the
// model writes it, once when the call is echoed back into context — to move
// bytes that are already sitting on disk. So the model WRITES the file with its
// ordinary file tools, looks at it, and passes the path. The same reason the
// media tools all name an output path instead of returning bytes, and it makes
// the two compose: generate_model writes a .glb, the model writes a viewer .html
// that loads it, save_cargo puts the viewer in the user's pocket.
//
// REFUSES RATHER THAN GUESSES. A kind that doesn't match the content is an
// artifact that opens broken, and the user finds out later, on their phone,
// with no way to tell what went wrong. So an unmappable extension is an error
// with the mappable ones named, and a kind that contradicts the extension
// (`kind: 'sheet'` on a .html) is refused rather than quietly honoured.
//
// SAYS WHAT DID AND DIDN'T TRAVEL. Saving is the one media-adjacent thing here
// that is genuinely end-to-end encrypted — the app encrypts before the POST and
// the server stores ciphertext it cannot read — which is the exact opposite of
// generation's posture (media.ts's header is blunt about that). A model that
// can't tell the two apart will describe one with the other's guarantees, so the
// description states this one plainly and the success line repeats it.
//
// AND WHAT HASN'T HAPPENED YET. A queued save is not a saved one: it is in no
// Cargo list until an app opens and files it. The queued line says so in as many
// words, because "saved" would send the user to look for something that isn't
// there yet.

import { Type } from "typebox";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import {
  CARGO_KINDS,
  MAX_CARGO_BYTES,
  isCargoKind,
  isHtmlKind,
  kindForExtension,
  type CargoKind,
  isUnattached,
  type CargoSaveRequest,
  type CargoSaveResult,
} from "../remote/cargoSave.ts";
import { postQueuedCargo, type QueuedCargoResult } from "../outbox/cloudOutbox.ts";

function text(t: string) {
  return { content: [{ type: "text", text: t }], details: {} };
}

/** The bridge surface this tool needs; RemoteBridge implements it. */
export interface CargoSaveBridge {
  saveCargoRemote(req: CargoSaveRequest, signal?: AbortSignal): Promise<CargoSaveResult>;
}

/** Where an artifact goes when no app is attached. Injectable for tests. */
export type CargoQueue = (req: CargoSaveRequest) => Promise<QueuedCargoResult>;

export const CARGO_TOOL_NAMES = ["save_cargo"] as const;

/**
 * Is `kind` a sane claim about a file called `ext`? An HTML kind needs an HTML
 * file and vice versa; the source kinds have to match their own family. Checked
 * because the failure is silent and late — the app stores whatever it is told
 * and only shows the mismatch when the user opens the artifact.
 */
function kindMatchesExtension(kind: CargoKind, ext: string): boolean {
  const implied = kindForExtension(ext);
  if (!implied) return false;
  // .html implies 'webpage', but slides and games are HTML documents too — the
  // extension can't tell them apart and the model can, so any HTML kind is fine
  // over an HTML file. The source kinds are exact.
  if (isHtmlKind(kind)) return isHtmlKind(implied);
  if (implied === "sheet") return kind === "sheet";
  return implied === "md" && (kind === "md" || kind === "pdf" || kind === "docx");
}

/**
 * `bridge` is the live route — absent in a session with no relay of its own (a harbor
 * run, a channels session), which then only ever queues. `queue` is the other route.
 */
export function makeSaveCargoTool(bridge?: CargoSaveBridge, queue: CargoQueue = postQueuedCargo) {
  return {
    name: "save_cargo",
    label: "Save to Cargo",
    description:
      "Save a file from disk into the user's Privateer app as Cargo — a titled artifact they can open, " +
      "preview, edit, download and share from any of their signed-in devices. Use when the user asks for " +
      "something they want to KEEP or open away from this machine (a page, a slide deck, a playable game, " +
      "a report, a spreadsheet), rather than a file that only exists in this working directory. " +
      "Write the file first with your normal file tools and pass its path.\n" +
      "Accepts .html/.htm (kind webpage, slides or game — one self-contained document, all CSS and JS " +
      "inlined, since it opens with no network and no sibling files), .md (kind md, pdf or docx — the " +
      "kind picks what Download produces) and .csv (kind sheet). Max 512 KB; other file types cannot be " +
      "Cargo — use send_file_to_client to hand the user an image, video or PDF instead.\n" +
      "Works whether or not the Privateer app is attached. Attached: the app encrypts and stores it now. " +
      "Not attached: the artifact is sealed to the user's account key and queued, and the app files it the " +
      "next time it opens — it is NOT in Cargo until then, so say that rather than that it is saved. Either " +
      "way only the user's app can read it; the server holds ciphertext. That is a stronger guarantee than " +
      "the generate_* tools have — do not describe those the same way.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path of the file to save, relative to cwd or absolute (e.g. 'build/tower-defence.html').",
      }),
      kind: Type.Optional(
        Type.String({
          description:
            "What the artifact IS, which decides its label and what Download produces. " +
            "'webpage' | 'slides' | 'game' for an HTML document — pick the one that matches what you " +
            "built, they are not interchangeable to the user. 'pdf' | 'docx' | 'md' for markdown source. " +
            "'sheet' for CSV. Defaults from the file extension ('webpage' for .html), so set it whenever " +
            "you built a deck or a game.",
        }),
      ),
      title: Type.Optional(
        Type.String({
          description:
            "Title shown in the app's Cargo list. Say what the thing is, the way the user would name it " +
            "('Tower Defence', 'Q3 Expenses') — not the filename. Omitted → the app derives one from the content.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { path: string; kind?: string; title?: string },
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
      if (stat.size > MAX_CARGO_BYTES) {
        return text(
          `${params.path} is ${(stat.size / 1024).toFixed(0)} KB; a Cargo artifact caps at ${MAX_CARGO_BYTES / 1024} KB. ` +
            `Trim it, or send it as a file with send_file_to_client instead.`,
        );
      }

      const ext = extname(target);
      const implied = kindForExtension(ext);
      if (!implied) {
        return text(
          `${params.path} can't be Cargo: ${ext || "a file with no extension"} isn't an artifact format. ` +
            `Cargo holds .html/.htm (a self-contained page, deck or game), .md, or .csv. ` +
            `To put any other file on the user's device, use send_file_to_client.`,
        );
      }
      const kind = params.kind ?? implied;
      if (!isCargoKind(kind)) {
        return text(`Unknown kind '${String(params.kind)}'. Valid kinds: ${CARGO_KINDS.join(", ")}.`);
      }
      if (!kindMatchesExtension(kind, ext)) {
        return text(
          `kind '${kind}' doesn't match ${ext} — the artifact would open broken in the app. ` +
            `${ext} holds ${implied === "md" ? "markdown (kind md, pdf or docx)" : implied === "sheet" ? "CSV (kind sheet)" : "an HTML document (kind webpage, slides or game)"}. ` +
            `Either drop the kind and let the extension decide, or write the content the kind actually needs.`,
        );
      }

      // Read as UTF-8: every Cargo kind is text. A binary file that happened to be
      // named .html would arrive as replacement characters rather than as an error,
      // but it would also not be an artifact anyone could open, and the size/extension
      // checks above are what actually keep that case out.
      let content: string;
      try {
        content = readFileSync(target, "utf8");
      } catch (e) {
        return text(`Couldn't read ${params.path}: ${(e as Error).message}`);
      }
      if (!content.trim()) return text(`${params.path} has no content to save.`);

      const req: CargoSaveRequest = { content, kind, title: params.title?.trim() || undefined };
      const res: CargoSaveResult = bridge
        ? await bridge.saveCargoRemote(req, signal)
        : { ok: false, unattached: true, reason: "no app is attached to this session" };

      if (!res.ok && isUnattached(res)) {
        const queued = await queue(req);
        if (!queued.ok) {
          return text(
            `Couldn't save ${basename(target)} to Cargo. No Privateer app is attached (${res.reason}), ` +
              `and queueing it for the app failed: ${queued.reason}.`,
          );
        }
        const label = req.title ? `"${req.title}"` : basename(target);
        return text(
          `Queued ${label} for Cargo (${kind}, ${(stat.size / 1024).toFixed(0)} KB). No Privateer app is attached right now, ` +
            `so it was sealed to the user's account key and parked on the server as ciphertext only their app can open. ` +
            `It will appear in Cargo the next time the Privateer app opens on any of their devices — it is not there yet, ` +
            `so tell the user that rather than that it is saved.`,
        );
      }
      if (!res.ok) return text(`Couldn't save ${basename(target)} to Cargo: ${res.reason}`);
      return text(
        `Saved "${res.title}" to Cargo (${kind}, ${(stat.size / 1024).toFixed(0)} KB, ${res.storageType} storage, id ${res.cargoId}). ` +
          `The user can open, edit, download and share it from Cargo in the Privateer app. ` +
          `It was encrypted on their device before it was stored — the server holds only ciphertext.`,
      );
    },
  };
}
