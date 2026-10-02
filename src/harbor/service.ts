// Install the resident harbor as a per-user OS service so it auto-starts at login
// and survives the terminal closing — the difference between "the CLI is running"
// and "the harbor is reachable from the app even when no CLI is". macOS → launchd
// user agent; Linux → systemd --user unit. No root: everything lives under the
// user's own home and login session.
//
// The channels runner (chat platforms → agent turns) installs the same way, as its own
// unit: every function here takes a ServiceKind, defaulting to the harbor, so the
// desktop app's calls (installService(), serviceInfo(), …) are unchanged.
//
// ORDERING NOTE: this module is import-safe (node builtins + our paths only, no Pi),
// so the harbor CLI can load it without going through boot.ts.
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { globalDir } from "../config/paths.ts";
import { harborIsRunning, sendToHarbor, describeRelay, formatDuration, type IpcResponse } from "./ipc.ts";

export type ServiceKind = "harbor" | "channels";

interface ServiceSpec {
  label: string; // launchd label / reverse-dns id
  unit: string; // systemd --user unit name
  launcher: string; // bin/ file the unit runs with "run"
  description: string;
  // Pre-rename identity, kept ONLY so install/uninstall can evict a service a user
  // installed before the harbor rename ("daemon") — otherwise it lingers as an orphaned
  // launchd agent / systemd unit still running the old launcher. Never written.
  oldLabel?: string;
  oldUnit?: string;
}

const SPECS: Record<ServiceKind, ServiceSpec> = {
  harbor: {
    label: "pro.privateer.harbor",
    unit: "privateer-harbor.service",
    launcher: "privateer-harbor.mjs",
    description: "Privateer resident agent harbor (routines + app-driven task spawns)",
    oldLabel: "pro.privateer.daemon",
    oldUnit: "privateer-daemon.service",
  },
  channels: {
    label: "pro.privateer.channels",
    unit: "privateer-channels.service",
    launcher: "privateer-channels.mjs",
    description: "Privateer channels (Telegram/Slack/Discord/WhatsApp chats to agent turns)",
  },
};

// Absolute path to the node launcher that boots + runs the service (bin/privateer-*.mjs).
// Resolved from THIS module so it's correct for both a dev checkout and a global npm
// install (…/node_modules/privateer-agent/bin/privateer-harbor.mjs).
function launcherPath(kind: ServiceKind): string {
  const here = dirname(fileURLToPath(import.meta.url)); // …/src/harbor
  return resolve(here, "../../bin", SPECS[kind].launcher);
}

// The node binary to bake into the unit. We use the CURRENT interpreter (>=22, the
// bash launcher already picked a compatible one) by absolute path, so the service
// never depends on launchd/systemd having a usable PATH.
function nodeBinaryPath(): string {
  return process.execPath;
}

// The log FILE the service writes to (exported for the in-process rotation, logRotate.ts). macOS only: launchd appends stdout/stderr here.
// On Linux the unit logs to the journal (see logLocation), which rotates on its own.
export function logFilePath(kind: ServiceKind = "harbor"): string {
  return join(globalDir(), `${kind}.log`);
}

// Where to read this service's log, for humans: a file on macOS, a journalctl command
// on Linux. Reporting harbor.log on Linux pointed people at a file nothing ever wrote.
function logLocation(kind: ServiceKind, platform: NodeJS.Platform = process.platform): string {
  return platform === "linux" ? `journalctl --user -u ${SPECS[kind].unit}` : logFilePath(kind);
}

// Whether the interpreter we're baking in is an Electron binary rather than a plain
// `node`. It is when the desktop app installs the service: harborManager calls
// installService() in the Electron MAIN process, so nodeBinaryPath() resolves to
// …/Privateer.app/Contents/MacOS/Privateer. Same story one step removed for the
// desktop CLI shim, which is that binary under another name.
//
// This matters because an Electron binary is a GUI app by default and only behaves as
// Node when ELECTRON_RUN_AS_NODE is set — a fact the shim and harborManager both know
// (they set it on every spawn) and this module used not to. A unit written without it
// doesn't run the harbor: at every login launchd starts the whole desktop app with a
// script path in argv.
function interpreterIsElectron(binary: string): boolean {
  // The current process is the honest answer when we're the one being baked in.
  if (binary === process.execPath) return Boolean((process.versions as Record<string, string>).electron);
  // An already-installed unit, read back: judge it by the name. Every Node we ship or
  // expect — the standalone bundle's, an npm global's, a system one — is called `node`.
  return !/^node(\.exe)?$/i.test(basename(binary));
}

// Env we forward into the service so a non-default home / server URL survives. Kept
// tiny and explicit — the harbor reads the rest from ~/.privateer.
//
// ELECTRON_RUN_AS_NODE is NOT forwarded from the environment, it is derived: the
// desktop app's main process doesn't have it set (it's a GUI process) and still needs
// it in the unit. Keying off the binary instead of the ambient env is what makes the
// answer the same however installService() was reached.
function forwardedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PRIVATEER_HOME) env.PRIVATEER_HOME = process.env.PRIVATEER_HOME;
  if (process.env.PRIVATEER_SERVER_URL) env.PRIVATEER_SERVER_URL = process.env.PRIVATEER_SERVER_URL;
  if (interpreterIsElectron(nodeBinaryPath())) env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

// ── macOS (launchd) ─────────────────────────────────────────────────────────────

function launchAgentPath(kind: ServiceKind = "harbor"): string {
  return join(homedir(), "Library", "LaunchAgents", `${SPECS[kind].label}.plist`);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// KeepAlive is `{ SuccessfulExit: false }`, NOT plain `true` — restart on a crash,
// but leave a CLEAN exit alone. A bare `true` restarts unconditionally, which turns
// the two clean-exit paths into loops: the harbor that finds another one already
// holding the machine lock (exit 0 every ~10s, appending the same line to harbor.log
// forever — this is what produced a 7 MB log of "already running"), and a deliberate
// shutdown, which launchd would undo. Matches the systemd unit's Restart=on-failure.
export function launchdPlist(kind: ServiceKind = "harbor"): string {
  const args = [nodeBinaryPath(), launcherPath(kind), "run"];
  const envVars = forwardedEnv();
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const envXml = Object.entries(envVars)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n");
  const log = xmlEscape(logFilePath(kind));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SPECS[kind].label}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
${Object.keys(envVars).length ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envXml}\n  </dict>\n` : ""}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

// Evict a pre-rename launchd agent (pro.privateer.daemon) if one is installed, so the
// harbor rename doesn't leave the old service running the old launcher alongside it.
function evictOldLaunchd(kind: ServiceKind): void {
  const old = SPECS[kind].oldLabel;
  if (!old) return;
  const oldPlist = join(homedir(), "Library", "LaunchAgents", `${old}.plist`);
  if (existsSync(oldPlist)) {
    spawnSync("launchctl", ["unload", "-w", oldPlist], { stdio: "ignore" });
    rmSync(oldPlist, { force: true });
  }
}

function installLaunchd(kind: ServiceKind): void {
  evictOldLaunchd(kind);
  const plist = launchAgentPath(kind);
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, launchdPlist(kind));
  // Unload a prior copy (ignore failure — it may not be loaded), then load with -w so
  // it's enabled across reboots.
  spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["load", "-w", plist], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`launchctl load failed: ${(r.stderr || r.stdout || "").trim() || `exit ${r.status}`}`);
  }
}

function uninstallLaunchd(kind: ServiceKind): void {
  evictOldLaunchd(kind);
  const plist = launchAgentPath(kind);
  if (existsSync(plist)) {
    spawnSync("launchctl", ["unload", "-w", plist], { stdio: "ignore" });
    rmSync(plist, { force: true });
  }
}

// ── Linux (systemd --user) ───────────────────────────────────────────────────────

function systemdUnitPath(kind: ServiceKind = "harbor"): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "systemd", "user", SPECS[kind].unit);
}

// One systemd word: double-quoted with C-style escapes, and `%` doubled — systemd
// expands %-specifiers inside ExecStart= and Environment=, so a path or value with a
// literal % would otherwise be rewritten (or rejected) when the unit loads.
function sdQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

// The unit, hardened as far as a --user unit can go everywhere:
//   • NoNewPrivileges — nothing the agent runs can gain privileges (no sudo, no
//     setuid helpers). A routine allowed `bash` runs with exactly the user's rights.
//   • UMask=0077 — every file it creates (results, logs, staged media) is owner-only.
//   • StartLimit* — Restart=on-failure with no limit restarted a harbor that crashes
//     at boot every few seconds forever; five tries in five minutes, then it stays
//     down and `systemctl --user status` says why.
//   • KillMode=mixed — SIGTERM reaches the harbor alone, so its shutdown handler can
//     revoke its sessions; anything still running (MCP servers it spawned) is killed
//     after TimeoutStopSec.
// Deliberately NOT here: ProtectSystem/ProtectHome/PrivateTmp and the rest of the
// namespace family. In a user manager they need unprivileged user namespaces, and
// where those are off (many VPS kernels, hardened distros) systemd refuses to start
// the unit at all (status=226/NAMESPACE). Run the harbor as a dedicated user instead
// — that is the boundary that works on every box.
function systemdUnit(kind: ServiceKind = "harbor"): string {
  const exec = [nodeBinaryPath(), launcherPath(kind), "run"].map(sdQuote).join(" ");
  const envLines = Object.entries(forwardedEnv())
    .map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=${SPECS[kind].description}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${exec}
Restart=on-failure
RestartSec=10
UMask=0077
NoNewPrivileges=yes
KillMode=mixed
TimeoutStopSec=15
${envLines ? `${envLines}\n` : ""}
[Install]
WantedBy=default.target
`;
}

/** The generated systemd unit text (exported for tests). */
export function systemdUnitText(kind: ServiceKind = "harbor"): string {
  return systemdUnit(kind);
}

// Evict a pre-rename systemd --user unit (privateer-daemon.service) if present, so the
// harbor rename doesn't leave the old unit enabled alongside the new one.
function evictOldSystemd(kind: ServiceKind): void {
  const old = SPECS[kind].oldUnit;
  if (!old) return;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const oldUnit = join(base, "systemd", "user", old);
  if (existsSync(oldUnit)) {
    spawnSync("systemctl", ["--user", "disable", "--now", old], { stdio: "ignore" });
    rmSync(oldUnit, { force: true });
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  }
}

// The login name to linger. $USER is unset under cron, `su -c`, some container shells
// and CI — and `loginctl enable-linger ""` silently did nothing, so the service died
// with the SSH session that installed it. The passwd entry is the reliable answer.
function loginName(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER || process.env.LOGNAME || "";
  }
}

function installSystemd(kind: ServiceKind): void {
  // A box with no systemd user manager (a Docker/LXC container, WSL without systemd)
  // used to fail with systemctl's own cryptic error. Say what to do instead.
  const probe = spawnSync("systemctl", ["--user", "show-environment"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `No systemd user manager here (${(probe.stderr || probe.error?.message || `exit ${probe.status}`).trim()}). ` +
        `Run \`privateer ${kind} run\` under your own supervisor (a container's restart policy, supervisord, tmux) instead.`,
    );
  }
  evictOldSystemd(kind);
  const unit = systemdUnitPath(kind);
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, systemdUnit(kind));
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  // enable-linger so the user service keeps running with no active login session —
  // the whole point of "reachable even when no shell is open". Best-effort: it needs
  // no root on most distros, but don't fail the install if it's disallowed.
  const user = loginName();
  if (user) spawnSync("loginctl", ["enable-linger", user], { stdio: "ignore" });
  // Clear a StartLimit hit from an earlier, broken install, so --now actually starts it.
  spawnSync("systemctl", ["--user", "reset-failed", SPECS[kind].unit], { stdio: "ignore" });
  const r = spawnSync("systemctl", ["--user", "enable", "--now", SPECS[kind].unit], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`systemctl enable failed: ${(r.stderr || r.stdout || "").trim() || `exit ${r.status}`}`);
  }
}

function uninstallSystemd(kind: ServiceKind): void {
  evictOldSystemd(kind);
  const unit = systemdUnitPath(kind);
  spawnSync("systemctl", ["--user", "disable", "--now", SPECS[kind].unit], { stdio: "ignore" });
  if (existsSync(unit)) rmSync(unit, { force: true });
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
}

// ── Public API ───────────────────────────────────────────────────────────────────

export interface ServiceInfo {
  platform: NodeJS.Platform;
  supported: boolean;
  installed: boolean;
  unitPath: string;
  logPath: string;
  /** Installed unit predates a fix and should be rewritten — see unitNeedsRefresh(). */
  needsRefresh: boolean;
  /**
   * The installed unit points at a binary that no longer exists, so it can never
   * start again. Rewriting won't help — it has to be REMOVED. See unitIsStale().
   */
  stale: boolean;
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/**
 * The command baked into an INSTALLED unit — [interpreter, launcher, "run"] — read
 * back off disk. Null when there's nothing to read or the file doesn't parse, so
 * every caller's fallback is "can't tell", never "assume the worst".
 *
 * We parse rather than regenerate-and-compare on purpose: what we'd generate today
 * legitimately differs from a unit written by another copy of the agent (a dev
 * checkout, an npm global, the desktop app), and the questions below are about the
 * unit that is actually loaded.
 */
export function unitProgramPaths(platform: NodeJS.Platform, unitPath: string): string[] | null {
  if (!unitPath || !existsSync(unitPath)) return null;
  let body: string;
  try {
    body = readFileSync(unitPath, "utf8");
  } catch {
    return null;
  }
  if (platform === "darwin") {
    const array = body.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    if (!array) return null;
    const args = [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => xmlUnescape(m[1]));
    return args.length ? args : null;
  }
  if (platform === "linux") {
    const line = body.match(/^ExecStart=(.*)$/m);
    if (!line) return null;
    // Today's units write double-quoted words with C escapes and %% (sdQuote). Units
    // installed before that wrote single-quoted words with '\'' for an embedded quote;
    // both are still out there, so both parse.
    const args = [...line[1].matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^']|'\\'')*)'|(\S+)/g)].map((m) => {
      if (m[1] !== undefined) return m[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%");
      if (m[2] !== undefined) return m[2].replace(/'\\''/g, "'");
      return m[3];
    });
    return args.length ? args : null;
  }
  return null;
}

/**
 * Is the installed unit pointing at software that's gone?
 *
 * The unit bakes ABSOLUTE paths — the interpreter (process.execPath) and the harbor
 * launcher, resolved from wherever the installing copy of the agent lived. When the
 * desktop app is what installed it, both of those are inside Privateer.app, and
 * dragging the app to the Trash leaves a launchd job that fires at every login,
 * forever, running a binary that no longer exists. Nothing else notices: launchd has
 * no opinion about a missing program beyond failing to start it.
 *
 * So this is the check that makes "uninstall the app" finishable — see the desktop's
 * reapStaleService(), which tears the unit down the moment it sees one.
 */
export function unitIsStale(platform: NodeJS.Platform, unitPath: string): boolean {
  const args = unitProgramPaths(platform, unitPath);
  if (!args || args.length < 2) return false; // unreadable / unrecognised — say nothing
  return !existsSync(args[0]) || !existsSync(args[1]);
}

/**
 * Does the INSTALLED unit need rewriting? Deliberately narrow: a full text compare
 * against what we'd generate today would flag every service installed by a different
 * copy of the CLI (a dev checkout resolves a different launcher path), which is not a
 * problem and not something the user should be nagged about. Two things are worth
 * flagging, both of which mean the unit does not do what it says:
 *
 *   • the pre-fix launchd `KeepAlive: true`, which restarts the harbor even after a
 *     clean exit — the log-spam loop described above launchdPlist();
 *   • an Electron interpreter with no ELECTRON_RUN_AS_NODE — see forwardedEnv(). Such
 *     a unit starts the desktop APP at login instead of a harbor. Every unit the
 *     desktop app wrote before that fix has this shape.
 *
 * A stale unit is NOT reported here: rewriting one only re-bakes the same dead path.
 */
export function unitNeedsRefresh(platform: NodeJS.Platform, unitPath: string): boolean {
  if (!existsSync(unitPath)) return false;
  if (unitIsStale(platform, unitPath)) return false;
  let body: string;
  try {
    body = readFileSync(unitPath, "utf8");
  } catch {
    return false;
  }
  if (platform === "darwin" && /<key>KeepAlive<\/key>\s*<true\s*\/>/.test(body)) return true;
  // The Linux twin of the always-restart plist: no StartLimitBurst means a harbor that
  // crashes at boot is restarted every few seconds, forever.
  if (platform === "linux" && !/^StartLimitBurst=/m.test(body)) return true;
  const args = unitProgramPaths(platform, unitPath);
  if (args?.[0] && interpreterIsElectron(args[0]) && !/ELECTRON_RUN_AS_NODE/.test(body)) return true;
  return false;
}

function unitPathFor(platform: NodeJS.Platform, kind: ServiceKind): string {
  if (platform === "darwin") return launchAgentPath(kind);
  if (platform === "linux") return systemdUnitPath(kind);
  return "";
}

export function serviceInfo(kind: ServiceKind = "harbor"): ServiceInfo {
  const platform = process.platform;
  const unitPath = unitPathFor(platform, kind);
  return {
    platform,
    supported: platform === "darwin" || platform === "linux",
    installed: !!unitPath && existsSync(unitPath),
    unitPath,
    logPath: logLocation(kind, platform),
    needsRefresh: unitNeedsRefresh(platform, unitPath),
    stale: !!unitPath && unitIsStale(platform, unitPath),
  };
}

// Install the service for the current platform. Idempotent (rewrites + reloads).
export function installService(kind: ServiceKind = "harbor"): ServiceInfo {
  const platform = process.platform;
  if (platform === "darwin") installLaunchd(kind);
  else if (platform === "linux") installSystemd(kind);
  else throw new Error(`Auto-start isn't supported on ${platform}. Run \`privateer ${kind}\` yourself, or keep a terminal open.`);
  return serviceInfo(kind);
}

export function uninstallService(kind: ServiceKind = "harbor"): ServiceInfo {
  const platform = process.platform;
  if (platform === "darwin") uninstallLaunchd(kind);
  else if (platform === "linux") uninstallSystemd(kind);
  else throw new Error(`No service to remove on ${platform}.`);
  return serviceInfo(kind);
}

// `privateer channels status`: the unit, and which platforms the runner is serving
// right now (its heartbeat — channels/status.ts). Imported lazily: status.ts is
// import-safe, but this module should not pay for it on the harbor's paths.
export async function channelsStatusReport(): Promise<string> {
  const info = serviceInfo("channels");
  const { readRunningPlatforms } = await import("../channels/status.ts");
  const live = [...readRunningPlatforms()];
  const lines = [
    `platform:  ${info.platform}${info.supported ? "" : " (auto-start unsupported — run `privateer channels` manually)"}`,
    `service:   ${info.installed ? `installed (${info.unitPath})${info.stale ? " — STALE: run `privateer channels uninstall`" : info.needsRefresh ? " — needs rewriting; run `privateer channels install`" : ""}` : "not installed"}`,
    `channels:  ${live.length ? `serving ${live.join(", ")}` : "not running (no fresh heartbeat)"}`,
    `logs:      ${info.logPath}`,
  ];
  if (info.installed && !live.length) {
    lines.push("hint:      installed but not serving — check the log. With no channels.<platform> block in config.json it exits on purpose.");
  }
  lines.push("note:      channel changes from the app apply on restart (`privateer channels install` restarts it).");
  return lines.join("\n");
}

// Human-readable status for `privateer harbor status`: whether the service is
// installed, whether a harbor is answering on the IPC socket, and — the part that
// actually answers "why does the app say inactive?" — whether that harbor is
// connected to the relay. Answering IPC only proves a local process is alive; the
// app lists a harbor from the server's presence registry, which a dead relay socket
// drops within ~60s. Reporting the first as if it implied the second is what made a
// stale harbor look healthy from the terminal and offline from the phone.
export async function statusReport(): Promise<string> {
  const info = serviceInfo();
  let status: IpcResponse | null = null;
  try {
    status = await sendToHarbor({ cmd: "status" }, 3_000);
  } catch {
    status = null; // not running, or wedged — harborIsRunning() below tells them apart
  }
  const live = status ? status.ok : await harborIsRunning();
  const up = status && typeof status.uptimeSec === "number" ? `, up ${formatDuration(status.uptimeSec)}` : "";
  const pid = status?.pid ? `pid ${status.pid}${up}` : "answering IPC";
  const lines = [
    `platform:  ${info.platform}${info.supported ? "" : " (auto-start unsupported — run `privateer harbor` manually)"}`,
    `service:   ${info.installed ? `installed (${info.unitPath})${info.stale ? " — STALE: it points at software that's been removed; run `privateer harbor uninstall`" : info.needsRefresh ? " — needs rewriting; run `privateer harbor install`" : ""}` : "not installed"}`,
    `harbor:    ${live ? `running (${pid})` : "not reachable"}`,
  ];
  if (live) lines.push(`relay:     ${describeRelay(status?.relay)}`);
  lines.push(`logs:      ${info.logPath}`);
  // Surface a stale-unit hint: file present but nothing answering usually means it
  // failed to boot — the log path above is where to look.
  if (info.installed && !live) lines.push("hint:      service is installed but not answering — check the log for a boot error.");
  if (live && status?.relay && !status.relay.connected) {
    lines.push("hint:      Harbor is running but not reachable from the app. Restart it (`privateer harbor uninstall && privateer harbor install`) once the cause above is resolved.");
  }
  if (info.needsRefresh) {
    lines.push("hint:      the installed login service restarts Harbor even after a clean exit (older install) — run `privateer harbor install` to refresh it.");
  }
  return lines.join("\n");
}

// Best-effort read of the tail of the harbor log (for a `status --log` affordance or
// error surfacing). Returns "" if absent. Reads only the last `maxBytes` — the log can
// be megabytes, and this used to load all of it to keep 4 KB.
export function tailHarborLog(maxBytes = 4_000): string {
  let fd: number | undefined;
  try {
    fd = openSync(logFilePath("harbor"), "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
