import { createServer, createConnection, type Socket, type Server } from "node:net";
import { existsSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { globalDir } from "../config/paths.ts";
import type { Routine } from "../routines/schema.ts";

// The CLI/TUI talks to the resident harbor over a unix domain socket. The protocol
// is one JSON request per connection, answered with one JSON response, both
// newline-terminated. Kept tiny and local — nothing crosses the machine boundary.

export function harborSocketPath(): string {
  return join(globalDir(), "harbor.sock");
}

export type IpcRequest =
  | { cmd: "status" }
  | { cmd: "list" }
  | { cmd: "add"; routine: Routine }
  | { cmd: "remove"; idOrName: string }
  | { cmd: "pause"; idOrName: string }
  | { cmd: "resume"; idOrName: string }
  | { cmd: "run-now"; idOrName: string }
  | { cmd: "reload" };

export interface IpcResponse {
  ok: boolean;
  message?: string;
  routines?: Routine[];
  // Harbor liveness/uptime for `status`.
  pid?: number;
  uptimeSec?: number;
}

export type IpcHandler = (req: IpcRequest) => Promise<IpcResponse> | IpcResponse;

// Start the harbor-side socket server. Returns the Server so the caller can close it.
export function startIpcServer(handler: IpcHandler): Server {
  const path = harborSocketPath();
  // A stale socket file from a previous crash would block bind; remove it first.
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore — bind will surface a clearer error */
    }
  }
  const server = createServer((sock: Socket) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return; // wait for the full line
      const line = buf.slice(0, nl);
      void (async () => {
        let res: IpcResponse;
        try {
          res = await handler(JSON.parse(line) as IpcRequest);
        } catch (err) {
          res = { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
        sock.end(JSON.stringify(res) + "\n");
      })();
    });
    sock.on("error", () => sock.destroy());
  });
  server.listen(path, () => {
    try {
      chmodSync(path, 0o600); // owner-only IPC endpoint
    } catch {
      /* non-POSIX — best effort */
    }
  });
  return server;
}

// Client side: send one request, resolve with the response. Rejects if the harbor
// isn't running (no socket / connection refused) so callers can offer to start it.
export function sendToHarbor(req: IpcRequest, timeoutMs = 5_000): Promise<IpcResponse> {
  const path = harborSocketPath();
  return new Promise<IpcResponse>((resolve, reject) => {
    if (!existsSync(path)) {
      reject(new HarborNotRunningError());
      return;
    }
    const sock = createConnection(path);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("harbor did not respond in time"));
    }, timeoutMs);
    sock.on("connect", () => sock.end(JSON.stringify(req) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    sock.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buf.trim()) as IpcResponse);
      } catch {
        reject(new Error("malformed response from harbor"));
      }
    });
    sock.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ECONNREFUSED means a stale socket file with no listener behind it.
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") reject(new HarborNotRunningError());
      else reject(err);
    });
  });
}

export class HarborNotRunningError extends Error {
  constructor() {
    super("Harbor is not running. Start it with `privateer harbor`.");
    this.name = "HarborNotRunningError";
  }
}

// Convenience: is the harbor reachable right now?
export async function harborIsRunning(): Promise<boolean> {
  try {
    const res = await sendToHarbor({ cmd: "status" }, 2_000);
    return res.ok;
  } catch {
    return false;
  }
}
