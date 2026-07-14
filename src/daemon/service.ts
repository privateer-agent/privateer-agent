// Install the resident daemon as a per-user OS service so it auto-starts at login
// and survives the terminal closing — the difference between "the CLI is running"
// and "the daemon is reachable from the app even when no CLI is". macOS → launchd
// user agent; Linux → systemd --user unit. No root: everything lives under the
// user's own home and login session.
//
// ORDERING NOTE: this module is import-safe (node builtins + our paths only, no Pi),
// so the daemon CLI can load it without going through boot.ts.
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globalDir } from "../config/paths.ts";
import { daemonIsRunning } from "./ipc.ts";

const LABEL = "pro.privateer.daemon"; // launchd label / reverse-dns id
const UNIT = "privateer-daemon.service"; // systemd --user unit name

// Absolute path to the node launcher that boots + runs the daemon (bin/privateer-daemon.mjs).
// Resolved from THIS module so it's correct for both a dev checkout and a global npm
// install (…/node_modules/privateer-agent/bin/privateer-daemon.mjs).
function daemonLauncherPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // …/src/daemon
  return resolve(here, "../../bin/privateer-daemon.mjs");
}

// The node binary to bake into the unit. We use the CURRENT interpreter (>=22, the
// bash launcher already picked a compatible one) by absolute path, so the service
// never depends on launchd/systemd having a usable PATH.
function nodeBinaryPath(): string {
  return process.execPath;
}

function daemonLogPath(): string {
  return join(globalDir(), "daemon.log");
}

// Env we forward into the service so a non-default home / server URL survives. Kept
// tiny and explicit — the daemon reads the rest from ~/.privateer.
function forwardedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PRIVATEER_HOME) env.PRIVATEER_HOME = process.env.PRIVATEER_HOME;
  if (process.env.PRIVATEER_SERVER_URL) env.PRIVATEER_SERVER_URL = process.env.PRIVATEER_SERVER_URL;
  return env;
}

// ── macOS (launchd) ─────────────────────────────────────────────────────────────

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function launchdPlist(): string {
  const args = [nodeBinaryPath(), daemonLauncherPath(), "run"];
  const envVars = forwardedEnv();
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const envXml = Object.entries(envVars)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n");
  const log = xmlEscape(daemonLogPath());
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
${envVars.PRIVATEER_HOME || envVars.PRIVATEER_SERVER_URL ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envXml}\n  </dict>\n` : ""}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

function installLaunchd(): void {
  const plist = launchAgentPath();
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, launchdPlist());
  // Unload a prior copy (ignore failure — it may not be loaded), then load with -w so
  // it's enabled across reboots.
  spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
  const r = spawnSync("launchctl", ["load", "-w", plist], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`launchctl load failed: ${(r.stderr || r.stdout || "").trim() || `exit ${r.status}`}`);
  }
}

function uninstallLaunchd(): void {
  const plist = launchAgentPath();
  if (existsSync(plist)) {
    spawnSync("launchctl", ["unload", "-w", plist], { stdio: "ignore" });
    rmSync(plist, { force: true });
  }
}

// ── Linux (systemd --user) ───────────────────────────────────────────────────────

function systemdUnitPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "systemd", "user", UNIT);
}

function systemdUnit(): string {
  const exec = [nodeBinaryPath(), daemonLauncherPath(), "run"].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const envLines = Object.entries(forwardedEnv())
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join("\n");
  return `[Unit]
Description=Privateer resident agent daemon (routines + app-driven task spawns)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Restart=on-failure
RestartSec=5
${envLines}

[Install]
WantedBy=default.target
`;
}

function installSystemd(): void {
  const unit = systemdUnitPath();
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, systemdUnit());
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  // enable-linger so the user service keeps running with no active login session —
  // the whole point of "reachable even when no shell is open". Best-effort: it needs
  // no root on most distros, but don't fail the install if it's disallowed.
  spawnSync("loginctl", ["enable-linger", process.env.USER || ""], { stdio: "ignore" });
  const r = spawnSync("systemctl", ["--user", "enable", "--now", UNIT], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`systemctl enable failed: ${(r.stderr || r.stdout || "").trim() || `exit ${r.status}`}`);
  }
}

function uninstallSystemd(): void {
  const unit = systemdUnitPath();
  spawnSync("systemctl", ["--user", "disable", "--now", UNIT], { stdio: "ignore" });
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
}

function unitPathFor(platform: NodeJS.Platform): string {
  if (platform === "darwin") return launchAgentPath();
  if (platform === "linux") return systemdUnitPath();
  return "";
}

export function serviceInfo(): ServiceInfo {
  const platform = process.platform;
  const unitPath = unitPathFor(platform);
  return {
    platform,
    supported: platform === "darwin" || platform === "linux",
    installed: !!unitPath && existsSync(unitPath),
    unitPath,
    logPath: daemonLogPath(),
  };
}

// Install the service for the current platform. Idempotent (rewrites + reloads).
export function installService(): ServiceInfo {
  const platform = process.platform;
  if (platform === "darwin") installLaunchd();
  else if (platform === "linux") installSystemd();
  else throw new Error(`Auto-start isn't supported on ${platform}. Run \`privateer daemon\` yourself, or keep a terminal open.`);
  return serviceInfo();
}

export function uninstallService(): ServiceInfo {
  const platform = process.platform;
  if (platform === "darwin") uninstallLaunchd();
  else if (platform === "linux") uninstallSystemd();
  else throw new Error(`No service to remove on ${platform}.`);
  return serviceInfo();
}

// Human-readable status line for `privateer daemon status`: whether the service is
// installed AND whether a daemon is actually answering on the IPC socket right now.
export async function statusReport(): Promise<string> {
  const info = serviceInfo();
  const live = await daemonIsRunning();
  const lines = [
    `platform:  ${info.platform}${info.supported ? "" : " (auto-start unsupported — run `privateer daemon` manually)"}`,
    `service:   ${info.installed ? `installed (${info.unitPath})` : "not installed"}`,
    `daemon:    ${live ? "running (answering IPC)" : "not reachable"}`,
    `logs:      ${info.logPath}`,
  ];
  // Surface a stale-unit hint: file present but nothing answering usually means it
  // failed to boot — the log path above is where to look.
  if (info.installed && !live) lines.push("hint:      service is installed but not answering — check the log for a boot error.");
  return lines.join("\n");
}

// Best-effort read of the tail of the daemon log (for a `status --log` affordance or
// error surfacing). Returns "" if absent.
export function tailDaemonLog(maxBytes = 4_000): string {
  try {
    const buf = readFileSync(daemonLogPath(), "utf8");
    return buf.length > maxBytes ? buf.slice(buf.length - maxBytes) : buf;
  } catch {
    return "";
  }
}
