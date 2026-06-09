import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { resolveInCwd, displayPath } from "./context.ts";
import { PermissionDeniedError } from "../permissions/gate.ts";
import { isProtectedPath } from "../permissions/protected.ts";

export function saveAttachmentTool(ctx: ToolContext) {
  return tool({
    description:
      "Save a user-attached file (image, PDF, audio, or video — shown in the prompt as a " +
      '"[Image #n]" / "[PDF #n]" / etc. chip) to a path on disk. Use this to persist a pasted ' +
      "or dragged-in attachment instead of trying to copy it from a temp or drop path, which is " +
      "unreliable and may be an empty placeholder. `ref` is the number n from the chip.",
    inputSchema: z.object({
      ref: z
        .number()
        .int()
        .describe("The attachment reference number n, taken from its [Kind #n] chip."),
      path: z.string().describe("Destination file path to write the attachment to."),
    }),
    execute: async ({ ref, path }) => {
      const store = ctx.attachments;
      const entry = store?.get(ref);
      if (!entry) {
        const avail = store?.refs() ?? [];
        return avail.length
          ? `No attachment #${ref}. Available this session: ${avail.map((n) => `#${n}`).join(", ")}.`
          : `No attachment #${ref}: nothing has been attached this session.`;
      }
      const abs = resolveInCwd(ctx, path);
      const decision = await ctx.gate.request({
        tool: "save_attachment",
        kind: "write",
        title: "Save attachment",
        detail: `[#${ref}] → ${displayPath(ctx, abs)} (${entry.mediaType})`,
        protected: isProtectedPath(abs),
      });
      if (decision === "deny") throw new PermissionDeniedError("save_attachment");

      ctx.recordMutation?.(abs);
      mkdirSync(dirname(abs), { recursive: true });
      const bytes = readFileSync(entry.path);
      writeFileSync(abs, bytes);
      return `Saved attachment #${ref} to ${displayPath(ctx, abs)} (${bytes.length} bytes).`;
    },
  });
}
