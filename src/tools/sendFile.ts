// The `send_file_to_client` tool — stream a file from disk up to the connected
// Privateer app (the phone/web client driving this terminal via /remote-access) so
// the user can preview/save it on their device. Ported from tree-cli, adapted to Pi
// registerTool + the RemoteBridge (which owns the relay's chunked sendFile). Gated by
// our permission-gate extension like any tool.

import { Type } from "typebox";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

const MAX_SEND_BYTES = 10 * 1024 * 1024; // mirrors the relay's per-file cap

const MEDIA: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", pdf: "application/pdf", txt: "text/plain", md: "text/markdown",
  json: "application/json", csv: "text/csv", html: "text/html", mp4: "video/mp4",
  mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", zip: "application/zip",
};
function mediaTypeForPath(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA[ext] ?? "application/octet-stream";
}

function text(t: string) {
  return { content: [{ type: "text", text: t }], details: {} };
}

export interface SendFileBridge {
  isConnected(): boolean;
  sendFile(file: { name: string; mediaType: string; base64: string; size: number }): Promise<{ ok: boolean; reason?: string }>;
}

export function makeSendFileTool(bridge: SendFileBridge) {
  return {
    name: "send_file_to_client",
    label: "Send File to App",
    description:
      "Send a file from disk to the connected Privateer app (the phone/web client driving this terminal " +
      "remotely), where the user can preview it and save/share it on their device. Use when the user asks " +
      "to see, download, or receive a file on their phone or browser. Only works while remote access is on " +
      "and the app is connected; max 10 MB per file.",
    parameters: Type.Object({
      path: Type.String({ description: "Path of the file to send, relative to cwd or absolute." }),
    }),
    async execute(
      _toolCallId: string,
      params: { path: string },
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: { cwd?: string },
    ) {
      if (!bridge.isConnected()) {
        return text(
          "Cannot send: remote access is off or the app isn't connected right now. " +
            "Turn it on with /remote-access and open the Privateer app, then try again.",
        );
      }
      const cwd = ctx?.cwd ?? process.cwd();
      const abs = isAbsolute(params.path) ? params.path : resolve(cwd, params.path);
      if (!existsSync(abs)) return text(`File not found: ${params.path}`);
      const stat = statSync(abs);
      if (stat.isDirectory()) return text(`${params.path} is a directory — send a single file.`);
      if (stat.size === 0) return text(`${params.path} is empty — nothing to send.`);
      if (stat.size > MAX_SEND_BYTES) {
        return text(`${params.path} is ${(stat.size / 1048576).toFixed(1)} MB; the relay caps at ${MAX_SEND_BYTES / 1048576} MB per file.`);
      }
      const bytes = readFileSync(abs);
      const mediaType = mediaTypeForPath(abs);
      const res = await bridge.sendFile({ name: basename(abs), mediaType, base64: bytes.toString("base64"), size: bytes.length });
      return res.ok
        ? text(`Sent ${basename(abs)} (${bytes.length} bytes, ${mediaType}) to the connected app.`)
        : text(`Couldn't send ${basename(abs)}: ${res.reason ?? "unknown error"}. Is the app currently connected?`);
    },
  };
}
