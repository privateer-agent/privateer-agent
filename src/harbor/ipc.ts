import { createServer, createConnection, type Socket, type Server } from "node:net";
import { existsSync, unlinkSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { globalDir } from "../config/paths.ts";
import type { Routine } from "../routines/schema.ts";

// The CLI/TUI talks to the resident harbor over a unix domain socket. The protocol
// is one JSON request per connection, answered with one JSON response, both
// newline-terminated. Kept tiny and local — nothing crosses the machine boundary.

const isWindows = process.platform === "win32";

/**
 * Where the harbor listens.
 *
 * POSIX: a unix socket inside PRIVATEER_HOME, so it inherits that directory's
 * ownership and lives beside the log it writes.
 *
 * Windows has no unix sockets: `listen()` there accepts ONLY a name under
 * \\.\pipe\, and handing it a file path fails — which is why `privateer harbor`
 * could never start on Windows at all. The pipe name is derived from
 * globalDir() so a non-default PRIVATEER_HOME still gets its own harbor (the
 * pipe namespace is machine-global and has no directories to separate them),
 * and hashed because that namespace takes no backslashes.
 */
export function harborSocketPath(): string {
  if (isWindows) {
    const id = createHash("sha256").update(globalDir().toLowerCase()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\privateer-harbor-${id}`;
  }
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

/**
 * Why a harbor isn't on the relay, as a code rather than a sentence.
 *
 * `detail` below is written for a terminal — it names CLI commands and is English
 * only — so the app can't put it in front of a user. It used to have nothing else
 * to go on, and said "give it a moment" about every one of these, including the
 * three that never clear on their own. This is the machine-readable half.
 *
 *   terminated  remote access was switched off from the app; needs a restart
 *   signed-out  no account credentials on this machine
 *   refused     the server said no (plan's agent cap, rejected ticket) — standing
 *   connecting  genuinely still trying; this one really is worth a moment
 */
export type RelayReason = "terminated" | "signed-out" | "refused" | "connecting";

/**
 * The harbor's view of its own relay connection, reported by `status`.
 *
 * A harbor answering on this socket is running; that is NOT the same as being
 * reachable from the app, which needs the relay socket up (the server drops a
 * terminal from its presence registry ~60s after it stops hearing from it). The two
 * used to be conflated — "running (answering IPC)" while the app showed the same
 * harbor as offline — so every liveness report carries both now.
 */
export interface RelayStatus {
  /** The relay terminal id the app looks for ("routines-…"). */
  termId: string;
  /** Socket open right now, i.e. the app can see and drive this harbor. */
  connected: boolean;
  /** Seconds the current connection has been up. */
  upSec?: number;
  /** Seconds since the server last sent anything (frame, ping or pong). */
  quietSec?: number;
  /** Why it isn't connected, when we know: signed out, turned off from the app, … */
  detail?: string;
  /** The same fact as `detail`, for a caller that has to localize it. */
  reason?: RelayReason;
}

export interface IpcResponse {
  ok: boolean;
  message?: string;
  routines?: Routine[];
  // Harbor liveness/uptime for `status`.
  pid?: number;
  uptimeSec?: number;
  // Relay reachability for `status` — see RelayStatus.
  relay?: RelayStatus;
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
        // Windows has nothing to reclaim: a named pipe exists only while a
        // process holds it, so EADDRINUSE there always means a live harbor.
        if (isWindows) { reject(new HarborAlreadyRunningError()); return; }
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
    // The fast "nothing is there" path. Skipped on Windows: a named pipe isn't a
    // filesystem entry, so existsSync() is false even for a live harbor and this
    // check would report every one of them as not running.
    if (!isWindows && !existsSync(path)) {
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

// One-line, human rendering of a status reply's relay block — shared by
// `privateer harbor status` and the second-instance notice so both tell the same
// story. `undefined` means the harbor answering us predates this field.
export function describeRelay(relay?: RelayStatus): string {
  if (!relay) return "unknown (this harbor is an older build)";
  if (!relay.connected) {
    return `NOT connected — the app shows this Harbor as inactive${relay.detail ? ` (${relay.detail})` : ""}`;
  }
  const up = typeof relay.upSec === "number" ? `, up ${formatDuration(relay.upSec)}` : "";
  // A connected socket the server hasn't spoken on in a while is the half-open shape;
  // the watchdog drops it within ~75s, so say so rather than reporting a flat "connected".
  const quiet = typeof relay.quietSec === "number" && relay.quietSec > 40 ? `, quiet for ${relay.quietSec}s — checking` : "";
  return `connected — drivable from the Privateer app (${relay.termId}${up}${quiet})`;
}

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
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
