import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { ToolContext } from "./context.ts";
import { resolveInCwd, displayPath, guardScope } from "./context.ts";
import { mediaTypeForPath } from "../util/images.ts";

// Per-file ceiling for the relay's chunked file channel; mirrors the relay
// client's MAX_ATTACH_BYTES so the tool fails fast with a friendly message
// instead of letting the transfer be rejected mid-flight.
const MAX_SEND_BYTES = 10 * 1024 * 1024;

export function sendFileToClientTool(ctx: ToolContext) {
  return tool({
    description:
      "Send a file from disk to the connected Privateer app (the phone/web client driving this " +
      "terminal remotely), where the user can preview it and save/share it on their device. Use " +
      "when the user asks to see, download, or receive a file on their phone or browser. Only " +
      "works while remote access is on and the app is connected; max 10 MB per file.",
    inputSchema: z.object({
      path: z.string().describe("Path of the file to send, relative to cwd or absolute."),
    }),
    execute: async ({ path }) => {
      if (!ctx.sendFileToController) {
        return "Cannot send: remote access is not enabled in this session (/remote-access to enable).";
      }
      // Fail fast before touching the disk or prompting for out-of-scope access: the
      // controller closure is wired even while remote access is off, so without this we
      // would read (up to 10 MB) and possibly prompt only to have the send bounce.
      if (ctx.isRemoteConnected && !ctx.isRemoteConnected()) {
        return (
          "Cannot send: remote access is off or the app isn't connected right now. " +
          "Turn it on with /remote-access and open the Privateer app, then try again."
        );
      }
      const abs = resolveInCwd(ctx, path);
      if (!existsSync(abs)) return `File not found: ${displayPath(ctx, abs)}`;
      const stat = statSync(abs);
      if (stat.isDirectory()) return `${displayPath(ctx, abs)} is a directory — send a single file.`;
      if (stat.size === 0) return `${displayPath(ctx, abs)} is empty — nothing to send.`;
      if (stat.size > MAX_SEND_BYTES) {
        return (
          `${displayPath(ctx, abs)} is ${(stat.size / (1024 * 1024)).toFixed(1)} MB; ` +
          `the remote channel caps at ${MAX_SEND_BYTES / (1024 * 1024)} MB per file.`
        );
      }
      const blocked = await guardScope(ctx, abs, { kind: "read", title: "Send file to connected app" });
      if (blocked) return blocked;

      const bytes = readFileSync(abs);
      const mediaType = mediaTypeForPath(abs);
      const res = await ctx.sendFileToController({
        name: basename(abs),
        mediaType,
        base64: bytes.toString("base64"),
        size: bytes.length,
      });
      return res.ok
        ? `Sent ${basename(abs)} (${bytes.length} bytes, ${mediaType}) to the connected app.`
        : `Couldn't send ${basename(abs)}: ${res.reason ?? "unknown error"}. Is the app currently connected?`;
    },
  });
}
