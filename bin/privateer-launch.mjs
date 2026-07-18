#!/usr/bin/env node
// Cross-platform Privateer launcher — the single source of launch logic for every
// platform (macOS, Linux, Windows). `bin/privateer-tui` (unix) and the Windows
// `privateer.cmd` are thin shims that just pick a Node and run THIS file.
//
// It boots Pi's full interactive TUI with the Privateer moat + tool packs. The moat
// is installed as re-export SHIMS in the agent dir's extensions/, so BOTH this TUI
// and any subagents it spawns (child processes reading the same agent dir) load the
// identical set — including our permission gate. One source of truth via discovery
// (no `-e`, which would double-load vs discovery). Runs in the current directory;
// model via PRIVATEER_MODEL=provider/id.
//
// Ported from the original bash launcher; behaviour is intended to match exactly.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // bin/
const REPO = path.resolve(HERE, "..");
const isWin = process.platform === "win32";

const PRIVATEER_HOME = process.env.PRIVATEER_HOME || path.join(os.homedir(), ".privateer");
const ENV_FILE = path.join(REPO, ".env"); // dev-only; a real install has none

// --- bundle detection ------------------------------------------------------
// A self-contained bundle ships its own pinned Node at "$REPO/node[.exe]" plus a
// BUNDLE_INFO.json marker (built by scripts/build-bundle.mjs). When present we use
// that runtime and never touch system node/npm. Putting the bundle dir on PATH also
// lets any child that boots via `#!/usr/bin/env node` (Pi's cli.js, the subagent
// wrapper) resolve the bundled node.
const bundledNode = path.join(REPO, isWin ? "node.exe" : "node");
const BUNDLED = fs.existsSync(bundledNode) && fs.existsSync(path.join(REPO, "BUNDLE_INFO.json"));

// The node used for child processes. When bundled, the bundled runtime; otherwise the
// very node already running this script (a suitable >=22, since we booted under it).
const NODE_BIN = BUNDLED ? bundledNode : process.execPath;
// Make sure the chosen node's directory is on PATH for shebang-spawned grandchildren.
process.env.PATH = path.dirname(NODE_BIN) + path.delimiter + (process.env.PATH || "");

const args = process.argv.slice(2);
const sub = args[0];

// `privateer --version` — report OUR version, not Pi's. Left to Pi's cli.js it would
// print the pi-coding-agent version (e.g. 0.80.3); intercept so users see the
// Privateer release they installed. (The startup banner already shows this version.)
if (sub === "--version" || sub === "-V") {
  const ver = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).version; } catch { return null; } };
  const pv = ver(path.join(REPO, "package.json")) || "unknown";
  const pi = ver(path.join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
  console.log(`privateer ${pv}${pi ? ` (pi ${pi})` : ""}`);
  process.exit(0);
}

// Faithfully propagate a child's exit/signal, mirroring bash `exec`.
function runToCompletion(cmd, cmdArgs, opts = {}) {
  const child = spawn(cmd, cmdArgs, { stdio: "inherit", env: process.env, ...opts });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  child.on("error", (e) => {
    console.error(`privateer: failed to launch — ${e.message}`);
    process.exit(1);
  });
}

// --- `privateer update` ----------------------------------------------------
// Fetch the latest release and exit. Bundle installs re-run the download+extract
// installer; npm installs update the global package.
if (sub === "update") {
  if (BUNDLED) {
    console.log("Updating Privateer to the latest release…");
    if (isWin) {
      runToCompletion("powershell", ["-NoProfile", "-Command", "irm https://privateer.pro/install.ps1 | iex"]);
    } else {
      runToCompletion("sh", ["-c", "curl -fsSL https://privateer.pro/install.sh | sh"]);
    }
  } else {
    console.log("Updating privateer-agent to the latest release…");
    runToCompletion(isWin ? "npm.cmd" : "npm", ["install", "-g", "privateer-agent@latest"]);
  }
  // runToCompletion exits via the child's exit handler.
}

// --- `privateer daemon [run|install|uninstall|status]` ---------------------
// The resident background daemon (routines + app-driven headless task spawns). Boots
// straight into src/daemon via bin/privateer-daemon.mjs — no moat-shim install (the
// daemon loads the moat as in-code factories, not interactive extensions).
else if (sub === "daemon") {
  const nodeArgs = fs.existsSync(ENV_FILE) ? [`--env-file=${ENV_FILE}`] : [];
  runToCompletion(NODE_BIN, [...nodeArgs, path.join(REPO, "bin", "privateer-daemon.mjs"), ...args.slice(1)]);
}

// --- normal launch: install the moat, then exec Pi's TUI -------------------
else {
  // Windows has no bash out of the box, but Privateer's command tool needs one. If a
  // real bash isn't reachable, stop here with a clear, actionable message — otherwise
  // the user boots fine and only hits a cryptic `'bash' is not recognized` the first
  // time the agent tries to run a command. Unix always has a shell, so this is a no-op.
  ensureShellOrExit();

  const AGENT_DIR = path.join(PRIVATEER_HOME, "agent");
  const EXT_DIR = path.join(AGENT_DIR, "extensions");
  fs.mkdirSync(EXT_DIR, { recursive: true });

  // Install/refresh the moat + tool-pack shims. Each shim re-exports its target by
  // ABSOLUTE path (as a file:// URL, portable across OSes) so the target's own
  // relative imports resolve from the repo. We remove any shim we previously managed
  // first, so a dropped package can't linger and reload.
  const MANAGED = [
    "privateer-brand", "privateer-context", "privateer-gate", "privateer-account",
    "privateer-models", "privateer-posture", "privateer-tools", "privateer-privacy",
    "pi-privacy", "pi-web-access", "rpiv-web-tools", "pi-mcp-adapter", "pi-hypa", "pi-subagents",
  ];
  for (const name of MANAGED) fs.rmSync(path.join(EXT_DIR, `${name}.ts`), { force: true });

  const ext = (...p) => path.join(REPO, "extensions", ...p);
  const dep = (...p) => path.join(REPO, "node_modules", ...p);
  const shim = (name, target) =>
    fs.writeFileSync(path.join(EXT_DIR, `${name}.ts`), `export { default } from ${JSON.stringify(pathToFileURL(target).href)};\n`);

  shim("privateer-brand", ext("privateer-brand.ts"));       // banner, ⚓ badge, /signin /signout
  shim("privateer-context", ext("privateer-context.ts"));   // PRIVATEER.md context + /init
  shim("privateer-gate", ext("privateer-gate.ts"));         // the permission gate (moat)
  shim("privateer-account", ext("privateer-account.ts"));
  shim("privateer-models", ext("privateer-models.ts"));     // /models picker w/ privacy shields
  shim("privateer-posture", ext("privateer-posture.ts"));
  shim("privateer-tools", ext("privateer-tools.ts"));
  shim("privateer-privacy", ext("privateer-privacy.ts"));   // pi-privacy + account tier resolver
  shim("rpiv-web-tools", dep("@juicesharp", "rpiv-web-tools", "index.ts")); // private web tools
  shim("pi-mcp-adapter", dep("pi-mcp-adapter", "index.ts"));
  shim("pi-hypa", dep("@hypabolic", "pi-hypa", "extensions", "index.ts"));
  shim("pi-subagents", dep("pi-subagents", "src", "extension", "index.ts"));

  const CLI = dep("@earendil-works", "pi-coding-agent", "dist", "cli.js");
  process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
  // The binary pi-subagents spawns for each child. Point it at OUR cli.js so the child
  // reads this same PI_CODING_AGENT_DIR and DISCOVERS the moat shims (gated + private,
  // no -e injection). Set only when unset so a power user can override.
  if (!process.env.PI_SUBAGENT_PI_BINARY) process.env.PI_SUBAGENT_PI_BINARY = CLI;
  // Suppress Pi's upstream update banner (our banner is the startup surface). Disables
  // ONLY the version fetch — fd/rg can still download on first run.
  if (!process.env.PI_SKIP_VERSION_CHECK) process.env.PI_SKIP_VERSION_CHECK = "1";

  // Quiet Pi's built-in startup chatter so our banner is the only greeting. Each key is
  // set only when unset, so a user's own settings.json toggle still wins.
  try {
    const sp = path.join(AGENT_DIR, "settings.json");
    let s = {};
    try { s = JSON.parse(fs.readFileSync(sp, "utf8")); } catch { /* new/absent */ }
    let m = false;
    if (s.quietStartup === undefined) { s.quietStartup = true; m = true; }
    if (s.collapseChangelog === undefined) { s.collapseChangelog = true; m = true; }
    if (s.lastChangelogVersion === undefined) { s.lastChangelogVersion = "9999.0.0"; m = true; }
    if (m) fs.writeFileSync(sp, JSON.stringify(s, null, 2) + "\n");
  } catch { /* best-effort */ }

  // Passive update check: refresh the cached "latest version" at most ~daily, in the
  // background so it never blocks or breaks launch (offline-safe). The banner reads
  // this cache and shows a "↑ vX available · run privateer update" notice. We never
  // auto-install. Fire-and-forget: the event loop stays alive while the TUI child runs.
  refreshUpdateCache();

  // Default model. Explicit PRIVATEER_MODEL wins; else Tinfoil GLM 5.2 (client-attested
  // TEE, strongest tier) when a Tinfoil key is present; else the signed-in account's
  // NEAR channel; else a cheap OpenRouter fallback.
  const CRED = path.join(PRIVATEER_HOME, "credentials.json");
  const MODEL = process.env.PRIVATEER_MODEL
    ? process.env.PRIVATEER_MODEL
    : haveTinfoilKey()
      ? "tinfoil/glm-5-2"
      : fs.existsSync(CRED)
        ? "privateer/near/zai-org/GLM-5.1-FP8"
        : "openrouter/openai/gpt-4o-mini";

  // Dev convenience: load provider keys from the repo's .env if present.
  const nodeArgs = fs.existsSync(ENV_FILE) ? [`--env-file=${ENV_FILE}`] : [];
  runToCompletion(NODE_BIN, [...nodeArgs, CLI, "--model", MODEL, ...args]);
}

// --- helpers ---------------------------------------------------------------

// Preflight: on Windows, make sure a bash the command tool can use actually exists.
// Mirrors pi-coding-agent's resolver (utils/shell.js getShellConfig): an explicit
// shellPath override wins, then Git Bash in Program Files, then any bash.exe on PATH.
// If none resolve, print branded install guidance and exit before the TUI loads.
function ensureShellOrExit() {
  if (!isWin) return; // macOS/Linux always ship /bin/sh (bash); nothing to check.

  // Respect an explicit shellPath in the agent settings — if the user set one, defer
  // to Pi's own resolver (it validates the path and reports its own error).
  try {
    const s = JSON.parse(fs.readFileSync(path.join(PRIVATEER_HOME, "agent", "settings.json"), "utf8"));
    if (s && typeof s.shellPath === "string" && s.shellPath.trim()) return;
  } catch { /* no settings file / no override — fall through to detection */ }

  if (findWindowsBash()) return; // a usable bash is reachable — carry on.

  const msg = [
    "",
    "  ⚓ Privateer needs a bash shell to run commands, and Windows doesn't ship one.",
    "",
    "  Fix it with any ONE of these, then run `privateer` again:",
    "",
    "    1. Install Git for Windows (recommended) — bundles Git Bash where Privateer",
    "       looks first, no config needed:  https://git-scm.com/download/win",
    "",
    "    2. Use WSL — run Privateer inside a WSL shell, or install it with",
    "       `wsl --install` from an admin PowerShell.",
    "",
    "    3. Already have Cygwin/MSYS2? Add its bash.exe to PATH, or set \"shellPath\"",
    "       to your bash.exe in your Privateer settings.json.",
    "",
    "  After installing, open a NEW terminal (PATH changes don't reach open windows).",
    "",
  ].join("\n");
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// Return the path to a usable bash.exe on Windows, or null. Same search order as
// pi-coding-agent: Git Bash under %ProgramFiles%[(x86)], then `where bash.exe`.
function findWindowsBash() {
  const candidates = [];
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, "Git", "bin", "bash.exe"));
  if (process.env["ProgramFiles(x86)"]) candidates.push(path.join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"));
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const r = spawnSync("where", ["bash.exe"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.trim().split(/\r?\n/)[0];
      if (first && fs.existsSync(first)) return first;
    }
  } catch { /* `where` unavailable — treat as not found */ }
  return null;
}

function haveTinfoilKey() {
  if (process.env.TINFOIL_API_KEY) return true;
  try { return /^TINFOIL_API_KEY=.+/m.test(fs.readFileSync(ENV_FILE, "utf8")); }
  catch { return false; }
}

function refreshUpdateCache() {
  const cache = path.join(PRIVATEER_HOME, "update-check.json");
  try {
    const stat = fs.statSync(cache);
    if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) return; // fresh (<1 day)
  } catch { /* missing — refresh */ }

  const write = (latest) => {
    if (!/^[0-9]/.test(latest || "")) return;
    try {
      fs.mkdirSync(PRIVATEER_HOME, { recursive: true });
      fs.writeFileSync(cache, JSON.stringify({ latest }) + "\n");
    } catch { /* best-effort */ }
  };

  if (BUNDLED) {
    // No npm in a bundle — read the latest tag off GitHub Releases.
    fetch("https://api.github.com/repos/privateer-agent/privateer-agent/releases/latest", {
      headers: { "User-Agent": "privateer-cli", Accept: "application/vnd.github+json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => write(String(j?.tag_name || "").replace(/^v/, "")))
      .catch(() => { /* offline — keep stale cache */ });
  } else {
    const p = spawn(isWin ? "npm.cmd" : "npm", ["view", "privateer-agent", "version"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => write(out.trim()));
    p.on("error", () => { /* no npm — ignore */ });
    p.unref();
  }
}
