// The `attach_to_result` tool — hand a file from disk to the Privateer Inbox
// alongside the answer this unattended run is about to deliver.
//
// The sibling of `send_file_to_client`, for the case that tool cannot serve: there
// is no controller attached and there won't be one. A routine that fires at 7am,
// or a task submitted from a phone that then went in a pocket, finishes into the
// cloud outbox — so its media has to travel the same way, sealed to the account
// key and collected when the app next syncs (src/routines/resultMedia.ts explains
// the transport; the ceilings live there too).
//
// Staging only. Nothing is read, sealed or uploaded here — the run may still fail
// after this call, and delivery decides what actually goes. That also keeps the
// tool cheap enough for a model to use freely: it is a promise about the answer,
// not an upload.

import { Type } from "typebox";
import type { ResultMedia } from "../routines/resultMedia.ts";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../routines/resultMedia.ts";

function text(t: string) {
  return { content: [{ type: "text", text: t }], details: {} };
}

export const ATTACH_RESULT_TOOL = "attach_to_result";

export function makeAttachResultTool(media: ResultMedia) {
  return {
    name: ATTACH_RESULT_TOOL,
    label: "Attach to Result",
    description:
      "Attach a file from disk — an image, video, audio clip or document — to the result this run " +
      "delivers to the user's Privateer Inbox, where they can view, save and share it on their device. " +
      "Use it for anything you generated or found that is better seen than described; the user is NOT " +
      "at this machine, so a file path in the answer is not something they can open. Attach the file " +
      `itself rather than pasting base64 into the answer. Up to ${MAX_ATTACHMENTS} files per result, ` +
      `${Math.round(MAX_ATTACHMENT_BYTES / 1048576)} MB each. Attaching the same path twice replaces the earlier entry.`,
    parameters: Type.Object({
      path: Type.String({ description: "Path of the file to attach, relative to cwd or absolute." }),
      caption: Type.Optional(
        Type.String({ description: "One short line shown under the attachment in the app." }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { path: string; caption?: string },
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: { cwd?: string },
    ) {
      const res = media.stage(params.path, ctx?.cwd ?? process.cwd(), params.caption);
      if (!res.ok) return text(`Not attached — ${res.reason}`);
      const kb = Math.max(1, Math.round(res.item.size / 1024));
      return text(
        `Attached ${res.item.name} (${kb} KB, ${res.item.mediaType}). It will be delivered with this result. ` +
          `Write the answer as if the user can see it — don't paste the file path as the way to open it.`,
      );
    },
  };
}

/** Registers the tool for a session that has a staging area. */
export function makeAttachResultTools(media: ResultMedia) {
  return function attachResultTools(pi: any): void {
    pi.registerTool?.(makeAttachResultTool(media));
  };
}
