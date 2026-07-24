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

// Probe whether a LIVE process is listening on the socket at `path`. Used as the
// single-instance test: a successful connect (or a slow-to-answer one) means a real
// harbor holds the lock; ECONNREFUSED/ENOENT means the socket file is stale (no
// listener behind it) and is safe to reclaim. Conservative — any ambiguous error
// resolves `true` so we never steal a path that might still be owned.
function probeExistingListener(path: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection(path);
    const done = (live: boolean) => {
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* already gone */ }
      resolve(live);
    };
    const timer = setTimeout(() => done(true), timeoutMs); // slow to answer ⇒ assume live
    sock.on("connect", () => done(true));
    sock.on("error", (err: NodeJS.ErrnoException) => {
      done(!(err.code === "ECONNREFUSED" || err.code === "ENOENT"));
    });
  });
}

// Start the harbor-side socket server. Resolves with the Server (so the caller can
// close it), or REJECTS with HarborAlreadyRunningError if a live harbor already owns
// the socket — the bind is the machine's single-instance lock. Two harbors under one
// ~/.privateer share a single routineRelayId(), so a second instance would collide on
// the relay and double-fire routines; refusing to start is the fix. A stale socket
// file (crash with no live listener) is detected and reclaimed, so recovery still works.
export function startIpcServer(handler: IpcHandler): Promise<Server> {
  const path = harborSocketPath();
  const build = (): Server =>
    createServer((sock: Socket) => {
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

  return new Promise<Server>((resolve, reject) => {
    // `reclaimed` guards a single stale-socket reclaim so a persistent bind failure
    // can't loop. On EADDRINUSE we probe for a live listener rather than unlinking
    // blindly (the old behavior, which let a second harbor silently steal the path).
    const attempt = (reclaimed: boolean) => {
      const server = build();
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EADDRINUSE") { reject(err); return; }
        void probeExistingListener(path).then((live) => {
          if (live) { reject(new HarborAlreadyRunningError()); return; }
          if (reclaimed) { reject(err); return; } // already reclaimed once — give up
          try { unlinkSync(path); } catch { /* ignore — retry surfaces a clearer error */ }
          attempt(true);
        });
      });
      server.listen(path, () => {
        try {
          chmodSync(path, 0o600); // owner-only IPC endpoint
        } catch {
          /* non-POSIX — best effort */
        }
        resolve(server);
      });
    };
    attempt(false);
  });
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

// Thrown by startIpcServer when a live harbor already holds this machine's socket —
// i.e. a second instance is trying to start under the same ~/.privateer. The caller
// (runHarbor) treats this as a clean no-op exit, not a crash.
export class HarborAlreadyRunningError extends Error {
  constructor() {
    super("A Harbor is already running on this machine.");
    this.name = "HarborAlreadyRunningError";
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
