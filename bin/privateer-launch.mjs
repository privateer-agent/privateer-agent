#!/usr/bin/env node
// Cross-platform Privateer launcher — the single source of launch logic for every
// platform (macOS, Linux, Windows). `bin/privateer-tui` (unix) and the Windows
// `privateer.cmd` are thin shims that just pick a Node and run THIS file.
//
// It boots Pi's full interactive TUI with the Privateer moat + tool packs, passed as
// explicit `-e` extension args (the same way --skill passes our bundled skills).
//
// We USED to install the moat as re-export shims in the agent dir's extensions/ and let
// Pi discover them. That directory is shared with every other Privateer process — the
// harbor daemon, the channels runner, ACP, the REPL — and Pi discovers it into every
// session built against that agent dir, so those processes each loaded a second copy of
// the moat on top of the one they build in code: a gate wired to a RemoteBridge nothing
// had attached a relay to, tool registrations that shadowed the session's own, and
// module-level state shared across concurrent sessions. Each entry point defended itself
// with a different env marker, and the ones nobody remembered to defend (media, MCP, web)
// were never covered at all. Passing `-e` instead means the agent dir's extensions/ holds
// ONLY the user's own extensions, so there is nothing of ours left to collide with, and
// each process loads exactly the moat it asked for. See src/config/moat.ts.
//
// Runs in the current directory; model via PRIVATEER_MODEL=provider/id.
//
// Ported from the original bash launcher; behaviour is intended to match exactly.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyPatchesIfNeeded, resolveDep } from "./apply-patches.mjs";
import { routeUpdate } from "./update-route.mjs";
import { runToCompletion } from "./run-to-completion.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // bin/
const REPO = path.resolve(HERE, "..");
const isWin = process.platform === "win32";

const PRIVATEER_HOME = process.env.PRIVATEER_HOME || path.join(os.homedir(), ".privateer");
const ENV_FILE = path.join(REPO, ".env"); // dev-only; a real install has none
const AGENT_DIR = path.join(PRIVATEER_HOME, "agent");
const EXT_DIR = path.join(AGENT_DIR, "extensions");

// WHAT to load comes from src/config/moatManifest.json — the same file the TS side derives
// extensionsControl's RESERVED set and the per-profile factory lists from, so adding an
// extension is one edit rather than four. JSON because this file runs before the patches,
// with no tsx and no dependencies. See src/config/moatManifest.ts.
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO, "src", "config", "moatManifest.json"), "utf8"));

// Releases up to 0.11 installed the moat as shim files here. They are no longer written
// (we pass `-e` instead), so any that survive an upgrade are stale — and a stale shim is
// worse than a missing one: Pi would discover it into every session sharing this agent
// dir, loading a second moat next to the one that process builds in code. Sweep on EVERY
// launch, not just the TUI's: a machine that only ever runs `privateer harbor` upgrades
// too, and its sessions are exactly the ones the duplicate hurt most.
function sweepLegacyShims() {
  if (!fs.existsSync(EXT_DIR)) return;
  for (const name of [...MANIFEST.shims.map((s) => s.name), ...MANIFEST.retired]) {
    try {
      fs.rmSync(path.join(EXT_DIR, `${name}.ts`), { force: true });
    } catch {
      /* a root-owned agent dir just means the stale shim stays; the in-process filter
         (src/config/moat.ts) still keeps it out of any session we build. */
    }
  }
}

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

// The command name to hand back to the user in copy-pasteable hints. Pi builds those
// from its own APP_NAME ("pi"), which is installed nowhere on a Privateer machine — so
// its "To resume this session: pi --session <id>" line pasted straight into
// `bash: pi: command not found`. npm's bin symlink keeps its own name in argv[1], so
// the invocation tells us the truth; internal entrypoints (privateer-launch.mjs, the
// privateer-tui shim) are not on anyone's PATH, so those fall back to the published
// bin name. Children inherit this via env; the patched formatResumeCommand reads it.
process.env.PRIVATEER_CMD ??= invokedCommandName();

function invokedCommandName() {
  const name = path.basename(process.argv[1] || "").replace(/\.(mjs|cjs|js|cmd|bat|exe)$/i, "");
  return !name || name.startsWith("privateer-") ? "privateer" : name;
}

// `--no-quarter` — total permission bypass ("take no prisoners"). Strip it from the
// args BEFORE anything else so it never reaches Pi's cli.js (which doesn't know it)
// and so `sub`/`args.slice(1)` see only real subcommands. When present we export
// PRIVATEER_NO_QUARTER=1; the permission gate (extensions/privateer-gate.ts, and any
// subagent child that inherits this env) then auto-approves EVERY action with no
// prompt — dangerous shell, destructive tools, out-of-cwd, protected files, all of
// it. This is the moat fully lowered; only pass it when you trust the whole session.
const NO_QUARTER = args.some((a) => a === "--no-quarter");
if (NO_QUARTER) {
  for (let i = args.length - 1; i >= 0; i--) if (args[i] === "--no-quarter") args.splice(i, 1);
  process.env.PRIVATEER_NO_QUARTER = "1";
  process.stderr.write(
    [
      "",
      "  ⚓ \x1b[1;31mNo quarter\x1b[0m — permission gate DISABLED for this session.",
      "     Every action (shell, edits, destructive tools, out-of-cwd) runs WITHOUT a prompt.",
      "     Only use this in a directory and with a task you fully trust.",
      "     shift+tab (or /no-quarter off) raises the moat again.",
      "",
    ].join("\n") + "\n",
  );
}

const sub = args[0];

// `privateer --version` — report OUR version, not Pi's. Left to Pi's cli.js it would
// print the pi-coding-agent version (e.g. 0.80.3); intercept so users see the
// Privateer release they installed. (The startup banner already shows this version.)
if (sub === "--version" || sub === "-V") {
  const ver = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).version; } catch { return null; } };
  const pv = ver(path.join(REPO, "package.json")) || "unknown";
  const piPkg = resolveDep(REPO, "@earendil-works/pi-coding-agent", "package.json");
  const pi = piPkg ? ver(piPkg) : null;
  console.log(`privateer ${pv}${pi ? ` (pi ${pi})` : ""}`);
  process.exit(0);
}

// Faithfully propagate a child's exit/signal, mirroring bash `exec`.
// npm gives no usable progress, so on a TTY show a braille spinner while it runs
// and keep its output buffered — shown only if the install fails. Non-TTY (CI,
// piped) keeps the old passthrough behaviour. The global package is replaced in
// place, so re-reading our own package.json afterwards yields the NEW version.
function updateNpmPackage() {
  const cmd = isWin ? "npm.cmd" : "npm";
  const npmArgs = ["install", "-g", "privateer-agent@latest", "--no-fund", "--no-audit"];
  if (!process.stdout.isTTY) {
    console.log("Updating privateer-agent to the latest release…");
    // npm is npm.cmd on Windows; Node >=18.20 needs a shell to spawn a .cmd (EINVAL otherwise).
    runToCompletion(cmd, npmArgs, { shell: isWin });
    return;
  }
  // Ask npm for the globally installed version — REPO/package.json would lie when
  // this copy runs from somewhere other than the global root (e.g. an npx cache).
  const globalVer = () => {
    try {
      const r = spawnSync(cmd, ["ls", "-g", "privateer-agent", "--depth=0", "--json"], { shell: isWin, encoding: "utf8" });
      return JSON.parse(r.stdout).dependencies?.["privateer-agent"]?.version ?? null;
    } catch { return null; }
  };
  const before = globalVer();
  console.log(`\x1b[1m⚓ Updating Privateer\x1b[0m${before ? ` \x1b[2m(currently ${before})\x1b[0m` : ""}`);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let captured = "";
  const child = spawn(cmd, [...npmArgs, "--loglevel=error"], { shell: isWin, env: process.env });
  child.stdout.on("data", (d) => (captured += d));
  child.stderr.on("data", (d) => (captured += d));
  process.stdout.write("\x1b[?25l");
  const t0 = Date.now();
  let i = 0;
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(`\r  \x1b[36m${frames[i++ % frames.length]}\x1b[0m updating privateer-agent@latest \x1b[2m${s}s\x1b[0m\x1b[K`);
  }, 80);
  const restore = () => { clearInterval(timer); process.stdout.write("\r\x1b[K\x1b[?25h"); };
  child.on("exit", (code, signal) => {
    restore();
    if (code === 0) {
      const after = globalVer();
      if (before && after && before === after) {
        console.log(`\x1b[32m✓\x1b[0m Already ship-shape — privateer-agent ${after} is the latest release.`);
      } else {
        console.log(`\x1b[32m✓\x1b[0m Updated privateer-agent${before ? ` ${before} →` : ""}${after ? ` ${after}` : ""}`);
        console.log(`\nRun \x1b[1mprivateer\x1b[0m to set sail on the new release.`);
      }
      process.exit(0);
    }
    if (captured.trim()) process.stderr.write(captured);
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  child.on("error", (e) => {
    restore();
    console.error(`privateer: failed to launch npm — ${e.message}`);
    process.exit(1);
  });
}

// Update the CLI itself: fetch the latest release and exit. Bundle installs re-run the
// download+extract installer; npm installs update the global package.
function updateSelf() {
  if (BUNDLED) {
    // PRIVATEER_UPDATE=1 flips the installer into update mode: weigh-anchor banner,
    // "X → Y" version reporting, and an early exit (no download) when already current.
    // ?update=1 tells the server this fetch is an update, not a fresh install.
    const env = { ...process.env, PRIVATEER_UPDATE: "1" };
    if (isWin) {
      runToCompletion("powershell", ["-NoProfile", "-Command", "irm 'https://privateer.pro/install.ps1?update=1' | iex"], { env });
    } else {
      runToCompletion("sh", ["-c", "curl -fsSL 'https://privateer.pro/install.sh?update=1' | sh"], { env });
    }
  } else {
    updateNpmPackage();
  }
  // both paths exit via their child's exit handler.
}

// Update TOOL PACKS (Pi "packages": npm/git sources contributing extensions, skills,
// prompts, themes) by handing the job to Pi's package-manager CLI, which owns npm/git
// installs, scopes and project trust. `then` runs only on a clean exit — that's how
// `--all` chains packs → self without either half being silently skipped.
//
// PI_CODING_AGENT_DIR is NOT optional here: without it Pi resolves the agent dir to a
// standalone ~/.pi/agent and would update packages belonging to a different install
// entirely, leaving the Privateer terminal's own packs untouched (and reporting success).
function updatePacks(cliArgs, then) {
  const CLI = resolveDep(REPO, "@earendil-works/pi-coding-agent", "dist", "cli.js");
  if (!CLI || !fs.existsSync(CLI)) {
    console.error(
      "privateer: couldn't find pi-coding-agent — the install looks incomplete.\n" +
        "  Try reinstalling: npm install -g privateer-agent@latest",
    );
    process.exit(1);
  }
  ensurePatches(); // project `.privateer/` config dirs are a patch; -l scope needs them
  const nodeArgs = fs.existsSync(ENV_FILE) ? [`--env-file=${ENV_FILE}`] : [];
  const env = { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR };
  const child = spawn(NODE_BIN, [...nodeArgs, CLI, "update", ...cliArgs], { stdio: "inherit", env });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else if (code === 0 && then) then();
    else process.exit(code ?? 0);
  });
  child.on("error", (e) => {
    console.error(`privateer: failed to launch the package manager — ${e.message}`);
    process.exit(1);
  });
}

// --- `privateer update [--extensions | --all | <pack>]` --------------------
// Two different things wear the same verb — the CLI itself and the tool packs — so the
// grammar and the reasoning behind it live in bin/update-route.mjs, next to its test.
// Tool packs can also be updated from inside a running terminal with /update, with no
// restart at all; see extensions/privateer-update.ts.
if (sub === "update") {
  const rest = args.slice(1);
  const route = routeUpdate(rest);
  if (route === "help") {
    const cmd = process.env.PRIVATEER_CMD || "privateer";
    console.log(
      [
        `${cmd} update — fetch the latest release, or newer tool packs.`,
        "",
        `  ${cmd} update                  update the Privateer CLI itself`,
        `  ${cmd} update --extensions     update every installed tool pack`,
        `  ${cmd} update <pack>           update one pack (npm name or git URL)`,
        `  ${cmd} update --all            tool packs, then the CLI`,
        "",
        "Inside a running terminal, /update fetches tool packs in place — no restart.",
      ].join("\n"),
    );
    process.exit(0);
  }
  if (route === "all") updatePacks(["--extensions"], updateSelf);
  else if (route === "packs") updatePacks(rest);
  else updateSelf();
}

// --- `privateer harbor [run|install|uninstall|status]` ---------------------
// The resident background harbor (routines + app-driven headless task spawns). Boots
// straight into src/harbor via bin/privateer-harbor.mjs — the harbor loads the moat as
// in-code factories, so it needs no `-e` args of its own.
// `daemon` is a hidden back-compat alias for the pre-rename command name.
else if (sub === "harbor" || sub === "daemon") {
  sweepLegacyShims(); // a harbor-only machine upgrades too — see the function's note
  const nodeArgs = fs.existsSync(ENV_FILE) ? [`--env-file=${ENV_FILE}`] : [];
  // A resident background process, stopped by launchd/systemd/scripts with a plain
  // `kill` — which reaches only this launcher. See runToCompletion.
  runToCompletion(NODE_BIN, [...nodeArgs, path.join(REPO, "bin", "privateer-harbor.mjs"), ...args.slice(1)], { forwardSignals: true });
}

// --- `privateer verify` ----------------------------------------------------
// Check the install that is on this disk right now. Every other trust signal we
// publish is an install-time one (npm provenance at `npm i`, a checksum inside
// install.sh, a badge on a web page nobody revisits); this is the one a user can
// run afterwards, on the machine they're worried about. Runs BEFORE ensurePatches
// so it can report the real patch state rather than the state it just created.
else if (sub === "verify") {
  runToCompletion(NODE_BIN, [path.join(REPO, "bin", "privateer-verify.mjs"), ...args.slice(1)]);
}

// --- `privateer acp` -------------------------------------------------------
// Privateer as an Agent Client Protocol server, spawned by an ACP host (Buzz's
// `buzz-acp`, Zed, …) and driven over newline-delimited JSON-RPC on stdio.
//
// ⚠️ STDOUT IS THE PROTOCOL here, so this branch must stay silent: no banner, no patch
// chatter (like `harbor`, the ACP entry loads the moat as in-code factories). A single
// stray stdout line breaks the JSON-RPC stream and the host disconnects.
else if (sub === "acp") {
  sweepLegacyShims(); // silent: only ever removes files
  const nodeArgs = fs.existsSync(ENV_FILE) ? [`--env-file=${ENV_FILE}`] : [];
  // Long-lived and driven over stdio by an editor, which stops it by terminating
  // the process rather than by a keystroke. Same leak, same fix.
  runToCompletion(NODE_BIN, [...nodeArgs, path.join(REPO, "bin", "privateer-acp.mjs"), ...args.slice(1)], { forwardSignals: true });
}

// --- normal launch: resolve the moat, then exec Pi's TUI with it -----------
else {
  // Windows has no bash out of the box, but Privateer's command tool needs one. If a
  // real bash isn't reachable, stop here with a clear, actionable message — otherwise
  // the user boots fine and only hits a cryptic `'bash' is not recognized` the first
  // time the agent tries to run a command. Unix always has a shell, so this is a no-op.
  ensureShellOrExit();

  // Apply our pi-coding-agent patches. This happens HERE, on a launch the user asked
  // for, rather than in a postinstall — so installing the package runs no code at all.
  // Stamped, so it's a single file read on every launch after the first. Best-effort:
  // both patches are UX fixes, so a root-owned node_modules (sudo npm i -g) just means
  // stock Pi behaviour, not a broken boot. Bundles ship pre-patched and no-op here.
  ensurePatches();

  // The agent dir's extensions/ is now the USER's alone — we create it so there's a place
  // to drop one, and clear out any shim an older release left behind.
  fs.mkdirSync(EXT_DIR, { recursive: true });
  sweepLegacyShims();

  // Resolve every moat entry point to an absolute path, to be passed to Pi as `-e`.
  // Dependencies resolve by walking the node_modules chain, NOT as REPO/node_modules: npm
  // only nests deps under us for a global install; `npx privateer-agent` and `npm i
  // privateer-agent` HOIST them to a sibling/parent node_modules, where a hardcoded path
  // resolves to nothing. A target that doesn't exist means that optional tool pack isn't
  // installed — drop it rather than passing a path Pi will fail to load.
  const dep = (name, ...rest) => resolveDep(REPO, name, ...rest);
  const MOAT_PATHS = MANIFEST.shims
    .map((s) => (s.entry ? path.join(REPO, s.entry) : dep(...s.dep)))
    .filter((p) => p && fs.existsSync(p));
  const extArgs = MOAT_PATHS.flatMap((p) => ["-e", p]);

  // Unlike the tool packs above, Pi's CLI is not optional — it IS the agent. If it
  // didn't resolve, the install is broken; say so instead of spawning `undefined`.
  const CLI = dep("@earendil-works/pi-coding-agent", "dist", "cli.js");
  if (!CLI || !fs.existsSync(CLI)) {
    console.error(
      "privateer: couldn't find pi-coding-agent — the install looks incomplete.\n" +
        "  Try reinstalling: npm install -g privateer-agent@latest",
    );
    process.exit(1);
  }
  process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
  // The binary pi-subagents spawns for each child, and the moat that child must load.
  //
  // ⚠️ SECURITY-LOAD-BEARING. A child used to inherit the moat by DISCOVERING the shims
  // from the shared agent dir — so pointing PI_SUBAGENT_PI_BINARY straight at cli.js was
  // enough. With the shims gone there is nothing to discover, and a child spawned that way
  // would run COMPLETELY UNGATED. So route children through our wrapper, which injects the
  // moat explicitly, and hand it the exact set this TUI is loading: a child gets its
  // parent's moat, not a hardcoded subset that drifts from it.
  if (!process.env.PI_SUBAGENT_PI_BINARY) {
    process.env.PI_SUBAGENT_PI_BINARY = path.join(REPO, "bin", "privateer-subagent.mjs");
  }
  process.env.PRIVATEER_CHILD_EXTENSIONS = MOAT_PATHS.join(path.delimiter);
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

  // Computed default model — used ONLY when the user has no saved pick and no
  // override (see modelArgs below). Mirrors src/providers/defaultModel.ts
  // resolveDefaultModel() — keep the two in step. Tinfoil's default is the same
  // either way: direct when the user has a Tinfoil key (pi-privacy can client-attest
  // the enclave), over the Privateer subscription otherwise.
  //
  // The last branch is the important one. A signed-out, keyless terminal used to launch
  // on `openrouter/openai/gpt-4o-mini`, which it had no key for — so the first prompt
  // died on "No API key found for openrouter", /login couldn't fix it (nothing switched
  // the live model), and the error named a provider the user had never heard of. It now
  // launches on the SAME account model it will use once signed in: nothing to switch,
  // the status bar shows what they're about to get, and the error until then names
  // Privateer and points at /login.
  const CRED = path.join(PRIVATEER_HOME, "credentials.json");
  const signedIn = fs.existsSync(CRED);
  // Mirrors TINFOIL_MODEL_ID in src/providers/defaultModel.ts — keep them in step; that
  // file carries the measurements behind the choice.
  const ACCOUNT_MODEL = "privateer/tinfoil/gpt-oss-120b";
  const MODEL = process.env.PRIVATEER_MODEL
    ? process.env.PRIVATEER_MODEL
    : haveTinfoilKey()
      ? "tinfoil/gpt-oss-120b"
      : signedIn
        ? ACCOUNT_MODEL
        : haveKey("ANTHROPIC_API_KEY")
          ? "anthropic/claude-opus-4-8"
          : haveKey("OPENAI_API_KEY")
            ? "openai/gpt-5.5"
            : haveKey("OPENROUTER_API_KEY")
              ? "openrouter/openai/gpt-4o-mini"
              : ACCOUNT_MODEL;

  // Nothing to run with: no model named, no BYO key, not signed in. The TUI still boots
  // (that's where /login lives), but say why up front — a returning user whose login
  // file vanished otherwise has no way to tell a cleared session from a first run.
  if (!signedIn && !process.env.PRIVATEER_MODEL && !haveByoKey()) {
    warnKeylessLaunch();
  }

  // Privateer's own bundled skills. Loaded by explicit path (Pi's `--skill`, which
  // takes a file or directory) rather than seeded into the agent dir, so they load
  // read-only from the shipped release — always matching this version, never
  // clobbering or resurrecting anything in the user's own editable skills dir. Each
  // is a directory holding a SKILL.md. Skip any that aren't present (e.g. a partial
  // dev checkout) so a missing dir can't wedge launch.
  const SKILL_DIRS = ["resolve-dependencies"]
    .map((name) => path.join(REPO, "skills", name))
    .filter((dir) => fs.existsSync(dir));
  const skillArgs = SKILL_DIRS.flatMap((dir) => ["--skill", dir]);

  // Honor the user's own persisted pick. Pi writes defaultProvider + defaultModel to
  // AGENT_DIR/settings.json on EVERY interactive switch (AgentSession.setModel — the
  // built-in selector and pi-privacy's /models picker both land there), but consults
  // it ONLY when no --model flag is passed (sdk.js: `let model = options.model` short-
  // circuits the settings default). Passing --model unconditionally was therefore the
  // "model switch doesn't persist" bug: every pick saved faithfully, then stomped at
  // the next launch. Precedence (mirrors resolveDefaultModel — keep in step):
  //   1. a --model the user typed on the privateer command line (already in `args`)
  //   2. PRIVATEER_MODEL — deliberate override, folded into MODEL above
  //   3. a saved pick in settings.json → pass NO flag; Pi resolves it itself (and
  //      falls back sanely if that model has vanished from the registry)
  //   4. nothing saved (first run / fresh home) → the computed MODEL above
  const userPassedModel = args.includes("--model");
  let savedDefault = null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(AGENT_DIR, "settings.json"), "utf8"));
    if (
      typeof s.defaultProvider === "string" && s.defaultProvider.trim() &&
      typeof s.defaultModel === "string" && s.defaultModel.trim()
    ) {
      savedDefault = `${s.defaultProvider}/${s.defaultModel}`;
    }
  } catch { /* absent/unreadable → no saved pick */ }
  const modelArgs =
    userPassedModel || (savedDefault && !process.env.PRIVATEER_MODEL) ? [] : ["--model", MODEL];

  // Dev convenience: load provider keys from the repo's .env if present.
  const nodeArgs = fs.existsSync(ENV_FILE) ? [`--env-file=${ENV_FILE}`] : [];

  // The boot splash. `--import` so it runs before Pi's entry module — most of the wait
  // it covers IS that module graph loading, so a splash started any later would miss it.
  // TUI branch only: harbor/acp/subagent children have no terminal to animate on (and
  // acp's stdout is a JSON-RPC stream). pathToFileURL, not the bare path — a Windows
  // absolute path reads as the URL scheme "d:"; see bin/privateer.mjs for the same trap.
  const splash = path.join(HERE, "privateer-splash.mjs");
  if (fs.existsSync(splash)) nodeArgs.push("--import", pathToFileURL(splash).href);

  runToCompletion(NODE_BIN, [...nodeArgs, CLI, ...modelArgs, ...extArgs, ...skillArgs, ...args]);
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

// Run the patch applier and, on the one interesting outcome (we tried and couldn't),
// tell the user why in a way they can act on. "current"/"applied"/"skipped" are silent.
function ensurePatches() {
  if (applyPatchesIfNeeded(REPO, NODE_BIN) !== "failed") return;

  // Most of the patch set is UX polish that degrades to stock Pi. The project config
  // dir is NOT: without the patch, `<cwd>/.privateer/` is a directory Pi has never
  // heard of, so a project's settings, packages, skills and extensions are ignored
  // outright. Say so — and say it louder when the current project actually has one,
  // because that user is about to run with a config they believe is loaded.
  const projectDirIgnored = fs.existsSync(path.join(process.cwd(), ".privateer"));
  process.stderr.write(
    [
      "",
      "  ⚓ Couldn't apply Privateer's bundled patches to node_modules — continuing without them.",
      "     Upstream fixes (retry-loop guard, /model → /models redirect) stay off, and this",
      "     project's `.privateer/` config directory is NOT read — only `.pi/` is.",
      ...(projectDirIgnored
        ? [
            "",
            `     THIS PROJECT HAS ONE: ${path.join(process.cwd(), ".privateer")}`,
            "     Its settings, packages, skills and extensions are being ignored right now.",
          ]
        : []),
      "",
      `     Usually a permissions issue: ${path.join(REPO, "node_modules")} isn't writable`,
      "     by this user (a `sudo npm install -g` install). Re-run once with sudo, or",
      "     install without sudo (nvm, or an npm prefix you own) to fix it for good.",
      "",
    ].join("\n") + "\n",
  );
}

function haveTinfoilKey() {
  return haveKey("TINFOIL_API_KEY");
}

// True if `name` is set in the environment or (dev convenience) present and non-empty in
// the repo .env — the same two sources the child inherits, so this matches what Pi will
// actually see for the provider key at request time.
function haveKey(name) {
  if (process.env[name]) return true;
  try { return new RegExp(`^${name}=.+`, "m").test(fs.readFileSync(ENV_FILE, "utf8")); }
  catch { return false; }
}

// Any BYO provider key that would make the keyless OpenRouter launch model usable (or at
// least give the runtime SOME working provider). Mirrors defaultModel.ts's BYO_BY_KEY.
function haveByoKey() {
  return ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TINFOIL_API_KEY"]
    .some(haveKey);
}

// Explain the keyless launch instead of letting the first prompt dead-end on a bare
// "No API key found for openrouter". Distinguishes a returning user whose login file is
// missing (other ~/.privateer state exists → likely signed out unexpectedly) from a
// genuine first run. Non-fatal: we print and carry on so `/login` inside still works.
function warnKeylessLaunch() {
  // Heuristic "was signed in before": the agent dir or our own config.json exists even
  // though credentials.json doesn't. A true first run has neither yet.
  let returning = false;
  try {
    returning =
      fs.existsSync(path.join(PRIVATEER_HOME, "agent")) ||
      fs.existsSync(path.join(PRIVATEER_HOME, "config.json"));
  } catch { /* best-effort — default to the first-run wording */ }

  const lines = returning
    ? [
        "",
        "  ⚓ Your Privateer login is missing — this terminal isn't signed in.",
        "",
        "  Run /login and approve the code in the Privateer app. You'll be back on your",
        "  subscription models straight away — no API key needed.",
        "",
      ]
    : [
        "",
        "  ⚓ Welcome aboard. Run /login to connect your Privateer account.",
        "",
        "  One approval in the Privateer app and you're running Tinfoil GLM 5.2 in a",
        "  trusted enclave — no API key needed. Prefer your own key? /login keys.",
        "",
      ];
  process.stderr.write(lines.join("\n") + "\n");
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
    // On Windows `npm` is npm.cmd; Node >=18.20 throws EINVAL synchronously when
    // spawning a .cmd without a shell, so run through a shell there and guard the
    // call — this is a fire-and-forget cache refresh and must never break launch.
    let p;
    try {
      p = spawn(isWin ? "npm.cmd" : "npm", ["view", "privateer-agent", "version"], {
        stdio: ["ignore", "pipe", "ignore"],
        shell: isWin,
        windowsHide: true,
      });
    } catch { return; /* no npm / spawn refused — keep stale cache */ }
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => write(out.trim()));
    p.on("error", () => { /* no npm — ignore */ });
    p.unref();
  }
}
