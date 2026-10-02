// Named terminals: the part that talks to the terminal program itself.
//
// A "terminal" here is a window (or tab, or tmux window) the user can SEE: the agent
// opens one for a dev server, a REPL or a second agent, gives it a name, and either
// of them can bring it to the front by that name later. Output is not read back:
// that is what bash and background tasks are for. These are for the person at the
// keyboard.
//
// IDENTITY IS THE TTY. Every backend can tell us which pseudo-terminal a window owns,
// and the same tty is what a process running inside it sees as its controlling
// terminal. So a Privateer started in a window we opened finds its own name by asking
// `ps` for its tty, and a window the user opened by hand can still be named and
// focused once a session inside it has registered it. Window titles would have been
// easier to match and are worthless as identity: the shell rewrites them on every
// prompt.
//
// ONE BACKEND ON PURPOSE PER PLACE. tmux wins whenever we are inside it, because there
// the "window" the user sees is tmux's, whatever app draws it. Outside tmux: macOS
// Terminal and iTerm2 through AppleScript, and Git Bash's own window (mintty) on Windows
// through PowerShell. Everything else (Ghostty, kitty, WezTerm, Windows Terminal, Linux
// terminals with no tmux) gets a clear "not here" rather than a guess: focusing a window
// by name there needs a window manager contract we can't count on, and tmux runs
// everywhere.
//
// On Windows there is no tty to go by, so a mintty window's id is its Windows process
// id: each window is one mintty.exe, and a Privateer inside finds it by walking up its
// parent processes.
//
// AppleScript runs as the terminal app controlling ITSELF (Privateer is a child of the
// window it draws in). Terminal does this without an Automation prompt (verified);
// iTerm2 is untested here and may ask once.

import { execFile, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TerminalApp = "tmux" | "Apple_Terminal" | "iTerm.app" | "mintty";

export interface OpenRequest {
  name: string;
  cwd: string;
  /** Typed into the new shell, so it runs with the user's own PATH and rc files. */
  command?: string;
  /** Bring it to the front (default). False leaves focus where it was. */
  focus: boolean;
}

export interface TerminalBackend {
  app: TerminalApp;
  /** Human name for messages. */
  label: string;
  /** Open a window and return its id (a tty path, or a tmux pane id). */
  open(req: OpenRequest): Promise<string>;
  /** Bring the window with this id to the front. False when it no longer exists. */
  focus(id: string): Promise<boolean>;
  /** Close it, ending what runs inside. False when it no longer exists. */
  close(id: string): Promise<boolean>;
  /** Ids of every window that exists right now, for pruning the registry. */
  live(): Promise<Set<string>>;
  /** The id of the window this process runs in, if it can tell. */
  selfId(): Promise<string | undefined>;
  /** Is this window the one in front, app and all? undefined when it can't tell. */
  isFront(id: string): Promise<boolean | undefined>;
  /**
   * Call `onChange` each time the window with this id comes to the front or goes
   * behind. Only where the terminal can't say so itself (mintty: see watchFront below).
   * Returns what stops watching.
   */
  watchFront?(id: string, onChange: (front: boolean) => void): () => void;
}

/** Run a program and hand back stdout; injectable so tests can see the exact calls. */
export type Exec = (file: string, args: string[]) => Promise<string>;

export const execProgram: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()));
      else resolve(String(stdout));
    });
  });

/** Single-quote for POSIX sh: the one quoting that has no special characters inside. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** An AppleScript string literal. */
export function asString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** What gets typed into a new shell: change to the folder, then run the command if any. */
export function shellLine(cwd: string, command?: string): string {
  const cd = `cd ${shQuote(cwd)}`;
  return command?.trim() ? `${cd} && ${command.trim()}` : cd;
}

const TTY = /\/dev\/tty[\w.]+/g;

/** This process's controlling tty as a /dev path, from ps (the one tool both Unixes ship). */
export async function ttyOf(pid: number, exec: Exec = execProgram): Promise<string | undefined> {
  try {
    const out = (await exec("ps", ["-o", "tty=", "-p", String(pid)])).trim();
    if (!out || out.startsWith("?")) return undefined;
    return out.startsWith("/dev/") ? out : `/dev/${out}`;
  } catch {
    return undefined;
  }
}

/**
 * Hang up everything running on a tty — what closing the window by hand does — so the
 * close that follows has nothing to ask about. Without this, Terminal answers a close
 * of a busy window with a "terminate running processes?" sheet, the window stays, and
 * every later close of it is swallowed by that sheet. (macOS `pkill -t` matches
 * nothing here, hence ps + kill.) Processes we may not signal (login) are skipped.
 */
export async function hangUp(tty: string, exec: Exec = execProgram): Promise<void> {
  const name = tty.replace(/^\/dev\//, "");
  let pids: string[];
  try {
    pids = (await exec("ps", ["-t", name, "-o", "pid="])).split(/\s+/).filter((p) => /^\d+$/.test(p));
  } catch {
    return; // nothing on it
  }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    await exec("kill", ["-HUP", pid]).catch(() => undefined);
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hang up, close, and confirm the window is really gone. The window is pinned by the
 * app's own id BEFORE the hang-up: once nothing runs on the tty, a lookup by tty no
 * longer finds it (see findTab), and a tty is reused the moment it's free.
 */
async function closeChecked(
  tty: string,
  exec: Exec,
  label: string,
  steps: { handle: () => Promise<string>; close: (handle: string) => Promise<unknown>; exists: (handle: string) => Promise<boolean> },
): Promise<boolean> {
  const handle = (await steps.handle()).trim();
  if (!handle || handle === "missing") return false;
  await hangUp(tty, exec);
  await pause(300);
  await steps.close(handle);
  for (let i = 0; i < 10; i++) {
    if (!(await steps.exists(handle))) return true;
    await pause(200);
  }
  throw new Error(`${label} kept the window open — it may be asking you to confirm. Close it by hand.`);
}

// ── macOS Terminal ──────────────────────────────────────────────────────────

// Every lookup walks windows → tabs and matches on tty. `return` inside the loops
// matters: closing a window mid-iteration invalidates the list being walked.
//
// Only tabs with something still running count. A window whose shell has exited stays
// on screen ("[Process completed]") still reporting its old tty, and macOS hands that
// tty to the next window opened — so without this, the dead window and the new one
// would answer to the same id.
const findTab = (tty: string, body: string): string => `
if application "Terminal" is not running then return "missing"
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is ${asString(tty)} and (count of processes of t) > 0 then
        ${body}
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "missing"`;

export function appleTerminal(exec: Exec = execProgram): TerminalBackend {
  const osa = (script: string) => exec("osascript", ["-e", script]);
  return {
    app: "Apple_Terminal",
    label: "Terminal",
    async open(req) {
      // `do script` with no target opens a new window and returns its tab.
      const out = await osa(`
tell application "Terminal"
  set t to do script ${asString(shellLine(req.cwd, req.command))}
  set custom title of t to ${asString(req.name)}
  set title displays custom title of t to true
  ${req.focus ? "activate" : ""}
  return tty of t
end tell`);
      const tty = out.match(TTY)?.[0];
      if (!tty) throw new Error(`Terminal opened a window but did not say which (${out.trim() || "no output"})`);
      return tty;
    },
    async focus(id) {
      // index 1 is "frontmost among Terminal's windows"; activate brings Terminal forward.
      return (await osa(findTab(id, "set selected of t to true\n        set index of w to 1\n        activate"))).trim() === "ok";
    },
    async close(id) {
      return closeChecked(id, exec, "Terminal", {
        handle: () => osa(findTab(id, "return id of w")),
        close: (wid) => osa(`tell application "Terminal" to close (window id ${Number(wid)})`),
        exists: async (wid) =>
          (await osa(`tell application "Terminal" to return exists window id ${Number(wid)}`)).trim() === "true",
      });
    },
    async live() {
      const out = await osa(`
if application "Terminal" is not running then return ""
set out to ""
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if (count of processes of t) > 0 then set out to out & (tty of t) & linefeed
    end repeat
  end repeat
end tell
return out`);
      return new Set(out.match(TTY) ?? []);
    },
    selfId: () => ttyOf(process.pid, exec),
    async isFront(id) {
      const out = await osa(`
if application "Terminal" is not running then return "false"
tell application "Terminal"
  if not frontmost then return "false"
  return ((tty of selected tab of front window) is ${asString(id)}) as text
end tell`);
      return out.trim() === "true";
    },
  };
}

// ── iTerm2 ──────────────────────────────────────────────────────────────────

const findSession = (tty: string, body: string): string => `
if application id "com.googlecode.iterm2" is not running then return "missing"
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is ${asString(tty)} then
          ${body}
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "missing"`;

export function iTerm(exec: Exec = execProgram): TerminalBackend {
  const osa = (script: string) => exec("osascript", ["-e", script]);
  return {
    app: "iTerm.app",
    label: "iTerm2",
    async open(req) {
      const out = await osa(`
tell application "iTerm2"
  set w to (create window with default profile)
  tell current session of w
    set name to ${asString(req.name)}
    write text ${asString(shellLine(req.cwd, req.command))}
    set theTty to tty
  end tell
  ${req.focus ? "activate" : ""}
  return theTty
end tell`);
      const tty = out.match(TTY)?.[0];
      if (!tty) throw new Error(`iTerm2 opened a window but did not say which (${out.trim() || "no output"})`);
      return tty;
    },
    async focus(id) {
      return (await osa(findSession(id, "select w\n          tell t to select\n          tell s to select\n          activate"))).trim() === "ok";
    },
    async close(id) {
      // A session's `id` is iTerm2's own unique identifier for it.
      const bySession = (sid: string, body: string) => `
if application id "com.googlecode.iterm2" is not running then return "missing"
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is ${asString(sid)} then
          ${body}
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell
return "missing"`;
      return closeChecked(id, exec, "iTerm2", {
        handle: () => osa(findSession(id, "return id of s")),
        close: (sid) => osa(bySession(sid, "tell s to close")),
        exists: async (sid) => (await osa(bySession(sid, ""))).trim() === "ok",
      });
    },
    async live() {
      const out = await osa(`
if application id "com.googlecode.iterm2" is not running then return ""
tell application "iTerm2" to return tty of every session of every tab of every window`);
      return new Set(out.match(TTY) ?? []);
    },
    selfId: () => ttyOf(process.pid, exec),
    async isFront(id) {
      const out = await osa(`
if application id "com.googlecode.iterm2" is not running then return "false"
tell application "iTerm2"
  if not frontmost then return "false"
  return ((tty of current session of current window) is ${asString(id)}) as text
end tell`);
      return out.trim() === "true";
    },
  };
}

// ── tmux ────────────────────────────────────────────────────────────────────

// Ids are pane ids (%12): stable for the pane's life and unique across sessions, where
// window indexes renumber. The command is typed into a shell rather than given to
// new-window, so the window outlives the command exactly as it does on macOS.
export function tmux(exec: Exec = execProgram, env: NodeJS.ProcessEnv = process.env): TerminalBackend {
  const run = (...args: string[]) => exec("tmux", args);
  const exists = async (id: string) => (await run("list-panes", "-a", "-F", "#{pane_id}")).split(/\s+/).includes(id);
  return {
    app: "tmux",
    label: "tmux",
    async open(req) {
      const id = (
        await run("new-window", ...(req.focus ? [] : ["-d"]), "-P", "-F", "#{pane_id}", "-n", req.name, "-c", req.cwd)
      ).trim();
      if (!/^%\d+$/.test(id)) throw new Error(`tmux opened a window but did not say which (${id || "no output"})`);
      if (req.command?.trim()) {
        await run("send-keys", "-t", id, "-l", req.command.trim());
        await run("send-keys", "-t", id, "Enter");
      }
      return id;
    },
    async focus(id) {
      if (!(await exists(id))) return false;
      // A pane in another session needs the client moved there first.
      await run("switch-client", "-t", id).catch(() => undefined);
      await run("select-window", "-t", id);
      await run("select-pane", "-t", id);
      return true;
    },
    async close(id) {
      if (!(await exists(id))) return false;
      await run("kill-window", "-t", id);
      return true;
    },
    async live() {
      return new Set((await run("list-panes", "-a", "-F", "#{pane_id}")).split(/\s+/).filter(Boolean));
    },
    selfId: async () => env.TMUX_PANE || undefined,
    // tmux knows whether the pane is the one showing, not whether the app drawing it is
    // in front: a pane that isn't showing is behind, one that is can't be sure.
    async isFront(id) {
      const out = (await run("display-message", "-p", "-t", id, "#{pane_active}#{window_active}")).trim();
      return out === "11" ? undefined : false;
    },
  };
}

// ── mintty (Git Bash on Windows) ────────────────────────────────────────────

/** Start a program in its own window and hand back its process id. Injectable for tests. */
export type Launch = (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<number>;

export const launchDetached: Launch = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...opts, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      if (child.pid) resolve(child.pid);
      else reject(new Error(`${file} started without a process id`));
    });
  });

/**
 * PowerShell, handed its script base64-encoded: the one way to get quotes, braces and
 * newlines through Windows' command line untouched.
 */
export function powershellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

// The few user32 calls PowerShell can't make on its own.
const USER32 = `
Add-Type -Namespace PV -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
'@
function FrontPid { $p = [uint32]0; [PV.U]::GetWindowThreadProcessId([PV.U]::GetForegroundWindow(), [ref]$p) | Out-Null; $p }
`;

/** Walk up from `pid` to the first mintty.exe; prints "<pid>|<exe path>" or nothing. */
export const minttyAncestorScript = (pid: number): string => `
$all = @{}
foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath) { $all[[int]$p.ProcessId] = $p }
$id = ${Math.trunc(pid)}
for ($i = 0; $i -lt 32 -and $all.ContainsKey($id); $i++) {
  $p = $all[$id]
  if ($p.Name -ieq 'mintty.exe') { Write-Output "$($p.ProcessId)|$($p.ExecutablePath)"; exit }
  $id = [int]$p.ParentProcessId
}`;

/**
 * Bring a window forward. Windows only lets the program in front hand the foreground
 * over; a tap of Alt is the long-standing way for a helper to be allowed to.
 */
export const minttyFocusScript = (pid: number): string => `${USER32}
$p = Get-Process -Id ${Math.trunc(pid)} -ErrorAction SilentlyContinue
if (-not $p -or $p.MainWindowHandle -eq 0) { Write-Output 'missing'; exit }
$h = $p.MainWindowHandle
if ([PV.U]::IsIconic($h)) { [PV.U]::ShowWindow($h, 9) | Out-Null }
[PV.U]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [PV.U]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[PV.U]::SetForegroundWindow($h) | Out-Null
Write-Output 'ok'`;

export const frontPidScript = `${USER32}
Write-Output (FrontPid)`;

/**
 * Print the foreground window's process id whenever it changes, until `owner` exits —
 * a process left behind on Windows isn't ended with its parent. 0 is skipped: there is
 * no foreground window for a moment during alt-tab, and reporting it would pause the
 * mic mid-word.
 */
export const frontWatchScript = (owner: number): string => `${USER32}
$last = -1; $n = 0
while ($true) {
  $p = FrontPid
  if ($p -ne 0 -and $p -ne $last) { $last = $p; [Console]::Out.WriteLine($p); [Console]::Out.Flush() }
  if ((++$n % 10) -eq 0 -and -not (Get-Process -Id ${Math.trunc(owner)} -ErrorAction SilentlyContinue)) { exit }
  Start-Sleep -Milliseconds 200
}`;

/** mintty's CSV process list → the ids of every mintty window. */
export function parseTasklist(out: string): Set<string> {
  const ids = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^"mintty\.exe","(\d+)"/i.exec(line.trim());
    if (m) ids.add(m[1]!);
  }
  return ids;
}

/** A Windows path as Git Bash reads it: forward slashes. */
const msysPath = (p: string): string => p.replace(/\\/g, "/");

export function mintty(
  exec: Exec = execProgram,
  launch: Launch = launchDetached,
  env: NodeJS.ProcessEnv = process.env,
  scripts: { dir: string; write: (path: string, body: string) => void } = { dir: tmpdir(), write: (p, b) => writeFileSync(p, b, { mode: 0o600 }) },
): TerminalBackend {
  const ps = (script: string) => exec("powershell.exe", powershellArgs(script));
  let self: Promise<{ pid: string; exe: string } | undefined> | undefined;
  const findSelf = () =>
    (self ??= ps(minttyAncestorScript(process.pid))
      .then((out) => {
        const [pid, exe] = out.trim().split("|");
        return pid && /^\d+$/.test(pid) ? { pid, exe: exe?.trim() || "mintty.exe" } : undefined;
      })
      .catch(() => undefined));
  const live = async () => parseTasklist(await exec("tasklist", ["/FI", "IMAGENAME eq mintty.exe", "/FO", "CSV", "/NH"]));
  return {
    app: "mintty",
    label: "Git Bash",
    async open(req) {
      const exe = (await findSelf())?.exe ?? "mintty.exe";
      const shell = env.SHELL || "/usr/bin/bash";
      // The command goes in a script file rather than on mintty's command line, where
      // Windows and Cygwin each have their own idea of quoting. It deletes itself, runs,
      // and leaves a login shell behind, so the window outlives the command.
      const file = join(scripts.dir, `privateer-term-${process.pid}-${Date.now()}.sh`);
      scripts.write(file, `rm -f "$0"\n${shellLine(req.cwd, req.command)}\nexec ${shQuote(shell)} -l\n`);
      // CHERE_INVOKING keeps Git Bash's login profile from moving the shell to $HOME.
      const pid = await launch(exe, ["-t", req.name, "-e", shell, "-l", msysPath(file)], {
        cwd: req.cwd,
        env: { ...env, CHERE_INVOKING: "1" },
      });
      return String(pid);
    },
    async focus(id) {
      return (await ps(minttyFocusScript(Number(id)))).trim() === "ok";
    },
    async close(id) {
      if (!(await live()).has(id)) return false;
      // /T takes the shell and whatever it runs along with the window.
      await exec("taskkill", ["/PID", id, "/T", "/F"]);
      return true;
    },
    live,
    selfId: async () => (await findSelf())?.pid,
    async isFront(id) {
      const out = (await ps(frontPidScript)).trim();
      return /^\d+$/.test(out) ? out === id : undefined;
    },
    watchFront(id, onChange) {
      const child = spawn("powershell.exe", powershellArgs(frontWatchScript(process.pid)), { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let last: boolean | undefined;
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!/^\d+$/.test(line.trim())) continue;
          const front = line.trim() === id;
          if (front !== last) onChange((last = front));
        }
      });
      child.on("error", () => undefined); // no PowerShell: focus just isn't tracked
      return () => void child.kill();
    },
  };
}

/**
 * The backend for the window this process is in, or why there isn't one. tmux first:
 * inside it, TERM_PROGRAM names the app that draws tmux, not the thing we can drive.
 */
export function detectBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exec: Exec = execProgram,
): TerminalBackend | { unsupported: string } {
  if (env.TMUX) return tmux(exec, env);
  if (platform === "darwin" && env.TERM_PROGRAM === "Apple_Terminal") return appleTerminal(exec);
  if (platform === "darwin" && env.TERM_PROGRAM === "iTerm.app") return iTerm(exec);
  if (platform === "win32" && env.TERM_PROGRAM === "mintty") return mintty(exec);
  const where = env.TERM_PROGRAM ? `${env.TERM_PROGRAM}` : platform === "win32" ? "this Windows terminal" : "this terminal";
  return {
    unsupported:
      `Named terminals work inside tmux, macOS Terminal, iTerm2 and Git Bash's own window (mintty) — not in ${where}. ` +
      (platform === "win32" ? `Run privateer from the Git Bash window to use them here.` : `Run privateer inside tmux to use them here.`),
  };
}
