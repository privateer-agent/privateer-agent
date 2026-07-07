// The `save_attachment` tool — persist a file the user attached from the app (shown
// in the prompt as "[Attachment #n] name") to a real path on disk. Ported from
// tree-cli to Pi registerTool; the in-tool ctx.gate.request is dropped (our gate
// extension gates the tool_call, classified as a write against the destination path).

import { Type } from "typebox";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AttachmentStore } from "../util/attachmentStore.ts";

function text(t: string) {
  return { content: [{ type: "text", text: t }], details: {} };
}

export function makeSaveAttachmentTool(store: AttachmentStore) {
  return {
    name: "save_attachment",
    label: "Save Attachment",
    description:
      "Save a file the user attached from the Privateer app (shown in the prompt as a \"[Attachment #n] " +
      "name\" chip) to a path on disk. Use this to persist a received attachment. `ref` is the number n.",
    parameters: Type.Object({
      ref: Type.Integer({ description: "The attachment reference number n from its [Attachment #n] chip." }),
      path: Type.String({ description: "Destination file path to write the attachment to." }),
    }),
    async execute(
      _toolCallId: string,
      params: { ref: number; path: string },
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: { cwd?: string },
    ) {
      const entry = store.get(params.ref);
      if (!entry) {
        const avail = store.refs();
        return text(
          avail.length
            ? `No attachment #${params.ref}. Available this session: ${avail.map((n) => `#${n}`).join(", ")}.`
            : `No attachment #${params.ref}: nothing has been attached this session.`,
        );
      }
      const cwd = ctx?.cwd ?? process.cwd();
      const abs = isAbsolute(params.path) ? params.path : resolve(cwd, params.path);
      mkdirSync(dirname(abs), { recursive: true });
      const bytes = readFileSync(entry.path);
      writeFileSync(abs, bytes);
      return text(`Saved attachment #${params.ref} (${entry.name}, ${entry.mediaType}) to ${params.path} (${bytes.length} bytes).`);
    },
  };
}
