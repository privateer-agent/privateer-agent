/**
 * Fresh agent: the launcher stays up as the TUI's supervisor, so a terminal can swap its
 * agent for a brand-new PROCESS without the user relaunching anything.
 *
 * WHY A PROCESS, NOT A SESSION. Pi's own /new (and an extension's ctx.newSession()) runs
 * in the same process. That is the wrong tool for both reasons this exists:
 *  - GARBAGE COLLECTION. A TUI can wedge, leak, or leave a pile of children behind (dev
 *    servers, watchers, subagents). A new session inherits all of it; a new process
 *    inherits none of it, because the old tree is reaped first.
 *  - ISOLATION. A subagent is a child its parent knows about. A fresh agent is not: it
 *    gets a new session file, no --continue, and nothing linking it to the one before.
 *
 * WHY THE LAUNCHER. It already sits above the TUI (runToCompletion), shares its
 * terminal, and is the one process that stays responsive when the agent does not. A
 * jammed agent can't run its own /fresh, voice command or hotkey — they all live on the
 * event loop that is jammed — so the rescue has to come from outside it.
 *
 * THE CONTROL CHANNEL. Each supervised terminal listens on a local socket (a unix socket
 * under PRIVATEER_HOME/run, a named pipe on Windows) and registers itself in
 * PRIVATEER_HOME/run/<launcherPid>.json. Anything that knows the socket AND the random
 * per-launch token can ask for a fresh agent: the /fresh command inside the TUI (handed
 * both through the environment) and `privateer fresh` from another terminal (reads them
 * from the 0600 registry file). The token is what stops another local user from
 * restarting your agent through a pipe whose default ACL they can open.
 *
 * REAPING, AND WHY IT SNAPSHOTS FIRST. Pi's bash tool spawns every command detached
 * (its own process group) on unix. The moment the TUI dies, those are reparented to init
 * and the parent→child link that says "this dev server belonged to that agent" is gone.
 * So the tree is read BEFORE anything is signalled: every descendant by ppid, plus every
 * process in a group one of them leads (which catches a grandchild whose own parent
 * already exited). SIGTERM first — Pi shuts down cleanly on it — then SIGKILL whatever
 * is left after the grace period. The launcher's own process group is never signalled as
 * a group: the TUI shares it (it's the terminal's foreground group), and so does the
 * launcher. Windows keeps no process groups worth using here; `taskkill /T` walks the
 * tree while it is still intact.
 *
 * Not caught: a process that double-forked AND called setsid on its own (a classic
 * daemon) before the snapshot. It has left both the tree and the group, and nothing short
 * of guessing by name would find it.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const isWin = process.platform === "win32";

/** How long the old agent gets to exit on SIGTERM before it is killed outright. */
export const FRESH_GRACE_MS = 3000;

/** Env the TUI (and so /fresh) receives: where its supervisor listens, and the key. */
export const FRESH_SOCKET_ENV = "PRIVATEER_FRESH_SOCKET";
export const FRESH_TOKEN_ENV = "PRIVATEER_FRESH_TOKEN";

// ── process tree (pure, tested) ─────────────────────────────────────────────

/** Parse `ps -A -o pid=,ppid=,pgid=` output into rows. Junk lines are skipped. */
export function parsePs(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid) && pid > 0) {
      rows.push({ pid, ppid, pgid });
    }
  }
  return rows;
}

/**
 * Everything to stop when `rootPid` is replaced: the root, all its descendants, and
 * every member of a process group a descendant leads. `protectPgid` is the supervisor's
 * own group — never signalled as a group, and members of it are only included when they
 * are real descendants of the root.
 *
 * Returns { pids, groups }: `groups` are signalled as -pgid (catching members we never
 * saw), `pids` individually.
 */
export function collectTree(rows, rootPid, protectPgid) {
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r);
  }
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const pids = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const p = queue.shift();
    for (const c of kids.get(p) ?? []) {
      if (!pids.has(c.pid)) {
        pids.add(c.pid);
        queue.push(c.pid);
      }
    }
  }
  const groups = new Set();
  for (const p of pids) {
    const g = byPid.get(p)?.pgid;
    if (g && g !== protectPgid && g > 1) groups.add(g);
  }
  // Orphans still in one of those groups: their parent exited before the snapshot, but
  // they are the same job and would otherwise outlive the agent that started it.
  for (const r of rows) if (groups.has(r.pgid)) pids.add(r.pid);
  return { pids: [...pids], groups: [...groups] };
}

/**
 * The user's own launch args, minus what would tie the new agent to the old one or
 * replay what it was told: session selection (--continue, --resume, --session,
 * --session-id, --fork, --name), the initial prompt, and @file attachments. Everything
 * about HOW to run stays — model, key, tools, posture flags like --no-quarter or
 * --allow-computer-control — because the user chose those for this terminal, and a
 * fresh agent that silently changed its permissions would be a different surprise.
 *
 * Walks the args with Pi's own grammar (dist/cli/args.js), because arity is the whole
 * problem: dropping a positional is only safe if we know it isn't the value of the flag
 * before it. Pi's rule for a flag it doesn't know (every extension flag) is to take the
 * next arg as its value unless it starts with "-" or "@"; so is ours.
 */
const DROP_BOOL = new Set(["-c", "--continue", "-r", "--resume"]);
const DROP_VALUE = new Set(["--session", "--session-id", "--fork", "--name", "-n"]);
const KEEP_BOOL = new Set([
  "--no-session", "--no-tools", "--no-builtin-tools", "--print", "--no-extensions", "--no-skills",
  "--no-prompt-templates", "--no-themes", "--no-context-files", "--verbose", "--approve",
  "--no-approve", "--offline", "--help", "--version",
]);
const KEEP_VALUE = new Set([
  "--mode", "--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt",
  "--session-dir", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking",
  "--export", "--extension", "-e", "--skill", "--prompt-template", "--theme", "--use-theme",
  "--tui-mode",
]);
export function filterRespawnArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break; // everything after is message text
    if (DROP_BOOL.has(a)) continue;
    if (DROP_VALUE.has(a)) {
      i++;
      continue;
    }
    if (KEEP_VALUE.has(a)) {
      if (i + 1 < args.length) out.push(a, args[++i]);
      continue;
    }
    if (KEEP_BOOL.has(a)) {
      out.push(a);
      continue;
    }
    if (a.startsWith("@")) continue; // file attachment for the old first prompt
    if (a.startsWith("--") && !a.includes("=")) {
      const next = args[i + 1];
      out.push(a);
      if (next !== undefined && !next.startsWith("-") && !next.startsWith("@")) out.push(args[++i]);
      continue;
    }
    if (a.startsWith("-")) {
      out.push(a); // --flag=value, or a short bool Pi knows
      continue;
    }
    // A bare word is an initial message: that was the OLD agent's task.
  }
  return out;
}

// ── registry + socket paths ─────────────────────────────────────────────────

export function runDir(home) {
  return path.join(home, "run");
}

function socketPath(home, token) {
  const id = `${process.pid}-${token.slice(0, 8)}`;
  if (isWin) return `\\\\.\\pipe\\privateer-fresh-${id}`;
  // sun_path is ~104 bytes on macOS; a long PRIVATEER_HOME (a dev home inside a repo)
  // can overflow it, and listen() then fails with a confusing EINVAL.
  const preferred = path.join(runDir(home), `${id}.sock`);
  return Buffer.byteLength(preferred) < 100 ? preferred : path.join(os.tmpdir(), `pv-fresh-${id}.sock`);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
};

/** Every supervised terminal still running, oldest first. Stale entries are removed. */
export function listTerminals(home) {
  const dir = runDir(home);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      const t = JSON.parse(fs.readFileSync(file, "utf8"));
      if (alive(t.pid)) {
        out.push(t);
        continue;
      }
      // A supervisor that died by signal (its terminal closed) never ran its exit
      // cleanup; its entry and socket are cleared by whoever looks next.
      fs.rmSync(file, { force: true });
      if (!isWin && typeof t.socket === "string" && t.socket.endsWith(".sock")) fs.rmSync(t.socket, { force: true });
    } catch {
      /* half-written or unreadable — not ours to act on */
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

// ── client ──────────────────────────────────────────────────────────────────

/** Ask one supervisor for a fresh agent. Resolves with its reply, rejects on no answer. */
export function requestFresh(socket, token, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socket);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("the terminal didn't answer"));
    }, timeoutMs);
    conn.on("connect", () => conn.write(JSON.stringify({ op: "fresh", token }) + "\n"));
    conn.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      conn.end();
      try {
        const reply = JSON.parse(buf.slice(0, nl));
        reply.ok ? resolve(reply) : reject(new Error(reply.error || "refused"));
      } catch {
        reject(new Error("unreadable reply"));
      }
    });
    conn.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// ── supervisor ──────────────────────────────────────────────────────────────

/** Put a terminal a killed TUI left in raw mode / hidden cursor / paste mode back. */
function resetTerminal() {
  if (!process.stdout.isTTY) return;
  if (!isWin) spawnSync("stty", ["sane"], { stdio: ["inherit", "ignore", "ignore"] });
  // Show cursor, leave the alternate screen, bracketed paste off, pop the kitty keyboard
  // protocol, reset attributes, then clear screen + scrollback so the new agent starts on
  // a blank page rather than under the old conversation.
  process.stdout.write("\x1b[?25h\x1b[?1049l\x1b[?2004l\x1b[<u\x1b[0m\x1b[2J\x1b[3J\x1b[H");
}

function snapshotTree(rootPid) {
  if (isWin) return null;
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" });
  if (r.status !== 0) return { pids: [rootPid], groups: [] };
  const rows = parsePs(r.stdout);
  const self = rows.find((x) => x.pid === process.pid);
  return collectTree(rows, rootPid, self?.pgid);
}

function signalTree(tree, sig) {
  for (const g of tree.groups) {
    try {
      process.kill(-g, sig);
    } catch {
      /* group already gone */
    }
  }
  for (const p of tree.pids) {
    try {
      process.kill(p, sig);
    } catch {
      /* already gone */
    }
  }
}

/** Stop the agent and everything it started. Resolves with how many processes that was. */
async function reap(child) {
  if (isWin) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return 1;
  }
  const tree = snapshotTree(child.pid);
  signalTree(tree, "SIGTERM");
  const deadline = Date.now() + FRESH_GRACE_MS;
  while (Date.now() < deadline && tree.pids.some(alive)) await new Promise((r) => setTimeout(r, 50));
  const survivors = { pids: tree.pids.filter(alive), groups: tree.groups };
  if (survivors.pids.length) signalTree(survivors, "SIGKILL");
  return tree.pids.length;
}

/**
 * Run the TUI under supervision. `buildArgs(first)` returns the node argv for each
 * launch — the first uses the user's args as typed, later ones go through
 * filterRespawnArgs — and is called fresh each time so a model the user picked in the old
 * session (saved to settings.json) is what the new one boots on.
 */
export function runSupervised(cmd, buildArgs, { home }) {
  const token = crypto.randomBytes(24).toString("hex");
  const dir = runDir(home);
  const regFile = path.join(dir, `${process.pid}.json`);
  const sock = socketPath(home, token);
  let child = null;
  let replacing = false;
  let registered = false;

  const register = () => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const entry = { pid: process.pid, childPid: child?.pid, socket: sock, token, cwd: process.cwd(), startedAt: Date.now() };
      fs.writeFileSync(regFile, JSON.stringify(entry) + "\n", { mode: 0o600 });
      registered = true;
    } catch {
      /* no registry means `privateer fresh` can't find this terminal; /fresh still works */
    }
  };
  const unregister = () => {
    if (registered) fs.rmSync(regFile, { force: true });
    if (!isWin) fs.rmSync(sock, { force: true });
  };

  const launch = (first) => {
    child = spawn(cmd, buildArgs(first), {
      stdio: "inherit",
      env: { ...process.env, [FRESH_SOCKET_ENV]: sock, [FRESH_TOKEN_ENV]: token },
    });
    child.on("exit", (code, signal) => {
      if (replacing) return;
      server.close();
      unregister();
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    });
    child.on("error", (e) => {
      console.error(`privateer: failed to launch — ${e.message}`);
      unregister();
      process.exit(1);
    });
    register();
  };

  const replace = async () => {
    if (replacing || !child) return;
    replacing = true;
    const old = child;
    const exited = new Promise((r) => (old.exitCode !== null || old.signalCode !== null ? r() : old.once("exit", r)));
    const count = await reap(old);
    await exited;
    resetTerminal();
    const extra = count > 1 ? ` and ${count - 1} process${count - 1 === 1 ? "" : "es"} it started` : "";
    process.stdout.write(`\x1b[2m⚓ Fresh agent — the previous one${extra} stopped.\x1b[0m\n`);
    replacing = false;
    launch(false);
  };

  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d;
      if (buf.length > 4096) return conn.destroy();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let msg = null;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch {
        /* falls through to refusal */
      }
      const given = Buffer.from(String(msg?.token ?? ""));
      const want = Buffer.from(token);
      const authed = given.length === want.length && crypto.timingSafeEqual(given, want);
      if (!authed || msg?.op !== "fresh") {
        conn.end(JSON.stringify({ ok: false, error: authed ? "unknown op" : "bad token" }) + "\n");
        return;
      }
      // Answer BEFORE reaping: when /fresh asked, the asker is the process about to die.
      conn.end(JSON.stringify({ ok: true, pid: process.pid }) + "\n");
      void replace();
    });
    conn.on("error", () => {});
  });
  server.on("error", () => {
    /* no control channel — the TUI still runs, only fresh-agent is unavailable */
  });

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* socketPath falls back to tmpdir only on length; an unwritable home just fails listen */
  }
  if (!isWin) fs.rmSync(sock, { force: true });
  const oldMask = isWin ? 0 : process.umask(0o077); // socket file created 0600
  server.listen(sock, () => {
    if (!isWin) process.umask(oldMask);
  });
  // listen() binds synchronously enough for the umask window; restore on failure too.
  server.once("error", () => {
    if (!isWin) process.umask(oldMask);
  });
  server.unref();

  process.on("exit", unregister);
  launch(true);
}
