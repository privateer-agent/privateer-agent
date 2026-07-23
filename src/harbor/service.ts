// Install the resident harbor as a per-user OS service so it auto-starts at login
// and survives the terminal closing — the difference between "the CLI is running"
// and "the harbor is reachable from the app even when no CLI is". macOS → launchd
// user agent; Linux → systemd --user unit. No root: everything lives under the
// user's own home and login session.
//
// ORDERING NOTE: this module is import-safe (node builtins + our paths only, no Pi),
// so the harbor CLI can load it without going through boot.ts.
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globalDir } from "../config/paths.ts";
import { harborIsRunning } from "./ipc.ts";

const LABEL = "pro.privateer.harbor"; // launchd label / reverse-dns id
const UNIT = "privateer-harbor.service"; // systemd --user unit name

// Pre-rename service identity ("daemon"). Kept ONLY so install/uninstall can evict a
// service a user installed before the harbor rename — otherwise it lingers as an
// orphaned launchd agent / systemd unit still running the old launcher. Never written,
// only torn down.
const OLD_LABEL = "pro.privateer.daemon";
const OLD_UNIT = "privateer-daemon.service";

// Absolute path to the node launcher that boots + runs the harbor (bin/privateer-harbor.mjs).
// Resolved from THIS module so it's correct for both a dev checkout and a global npm
// install (…/node_modules/privateer-agent/bin/privateer-harbor.mjs).
function harborLauncherPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // …/src/harbor
  return resolve(here, "../../bin/privateer-harbor.mjs");
}

// The node binary to bake into the unit. We use the CURRENT interpreter (>=22, the
// bash launcher already picked a compatible one) by absolute path, so the service
// never depends on launchd/systemd having a usable PATH.
function nodeBinaryPath(): string {
  return process.execPath;
}

function harborLogPath(): string {
  return join(globalDir(), "harbor.log");
}

// Env we forward into the service so a non-default home / server URL survives. Kept
// tiny and explicit — the harbor reads the rest from ~/.privateer.
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
  const args = [nodeBinaryPath(), harborLauncherPath(), "run"];
  const envVars = forwardedEnv();
  const argXml = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const envXml = Object.entries(envVars)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n");
  const log = xmlEscape(harborLogPath());
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

// Evict a pre-rename launchd agent (pro.privateer.daemon) if one is installed, so the
// harbor rename doesn't leave the old service running the old launcher alongside it.
function evictOldLaunchd(): void {
  const oldPlist = join(homedir(), "Library", "LaunchAgents", `${OLD_LABEL}.plist`);
  if (existsSync(oldPlist)) {
    spawnSync("launchctl", ["unload", "-w", oldPlist], { stdio: "ignore" });
    rmSync(oldPlist, { force: true });
  }
}

function installLaunchd(): void {
  evictOldLaunchd();
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
  evictOldLaunchd();
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
  const exec = [nodeBinaryPath(), harborLauncherPath(), "run"].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const envLines = Object.entries(forwardedEnv())
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join("\n");
  return `[Unit]
Description=Privateer resident agent harbor (routines + app-driven task spawns)
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

// Evict a pre-rename systemd --user unit (privateer-daemon.service) if present, so the
// harbor rename doesn't leave the old unit enabled alongside the new one.
function evictOldSystemd(): void {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const oldUnit = join(base, "systemd", "user", OLD_UNIT);
  if (existsSync(oldUnit)) {
    spawnSync("systemctl", ["--user", "disable", "--now", OLD_UNIT], { stdio: "ignore" });
    rmSync(oldUnit, { force: true });
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  }
}

function installSystemd(): void {
  evictOldSystemd();
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
  evictOldSystemd();
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
    logPath: harborLogPath(),
  };
}

// Install the service for the current platform. Idempotent (rewrites + reloads).
export function installService(): ServiceInfo {
  const platform = process.platform;
  if (platform === "darwin") installLaunchd();
  else if (platform === "linux") installSystemd();
  else throw new Error(`Auto-start isn't supported on ${platform}. Run \`privateer harbor\` yourself, or keep a terminal open.`);
  return serviceInfo();
}

export function uninstallService(): ServiceInfo {
  const platform = process.platform;
  if (platform === "darwin") uninstallLaunchd();
  else if (platform === "linux") uninstallSystemd();
  else throw new Error(`No service to remove on ${platform}.`);
  return serviceInfo();
}

// Human-readable status line for `privateer harbor status`: whether the service is
// installed AND whether a harbor is actually answering on the IPC socket right now.
export async function statusReport(): Promise<string> {
  const info = serviceInfo();
  const live = await harborIsRunning();
  const lines = [
    `platform:  ${info.platform}${info.supported ? "" : " (auto-start unsupported — run `privateer harbor` manually)"}`,
    `service:   ${info.installed ? `installed (${info.unitPath})` : "not installed"}`,
    `harbor:    ${live ? "running (answering IPC)" : "not reachable"}`,
    `logs:      ${info.logPath}`,
  ];
  // Surface a stale-unit hint: file present but nothing answering usually means it
  // failed to boot — the log path above is where to look.
  if (info.installed && !live) lines.push("hint:      service is installed but not answering — check the log for a boot error.");
  return lines.join("\n");
}

// Best-effort read of the tail of the harbor log (for a `status --log` affordance or
// error surfacing). Returns "" if absent.
export function tailHarborLog(maxBytes = 4_000): string {
  try {
    const buf = readFileSync(harborLogPath(), "utf8");
    return buf.length > maxBytes ? buf.slice(buf.length - maxBytes) : buf;
  } catch {
    return "";
  }
}
