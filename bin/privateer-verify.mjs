// `privateer verify` — check the install that is actually on this disk.
//
// Every other trust signal we offer is an INSTALL-TIME signal: npm provenance is
// checked when you install, install.sh verifies a checksum before it unpacks, the
// npm page shows a green badge to whoever is looking at the npm page. None of that
// answers the question a user actually has three weeks later, which is "is the
// thing on my machine right now still the thing you published?"
//
// So this command reads local state first and the network second, and it is careful
// about the difference between "verified", "couldn't check", and "wrong". A check
// that cannot reach the registry says so; it never reports a pass it didn't make.
//
// Deliberately NOT a security boundary: anything that can rewrite node_modules can
// rewrite this file too. It is a tampering *smoke alarm* and an honest inventory —
// useful exactly because most breakage is accidental (a half-finished upgrade, a
// stale patch stamp, a hand-edited dependency) rather than adversarial.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findDepRoot } from "./apply-patches.mjs";

const REGISTRY = process.env.npm_config_registry || "https://registry.npmjs.org";
const NET_TIMEOUT_MS = 8000;

// --- tiny reporter ---------------------------------------------------------
// Three outcomes, and the third one is the point: "unknown" must never be
// rendered as a pass. Exit code reflects only real failures, so `privateer verify`
// is safe to put in a CI step without breaking on an offline runner.
const C = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (C ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (C ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s) => (C ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (C ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s) => (C ? `\x1b[33m${s}\x1b[0m` : s);

let failures = 0;
let unknowns = 0;

function pass(label, detail) {
  console.log(`  ${green("✓")} ${label}${detail ? ` ${dim(detail)}` : ""}`);
}
function fail(label, detail) {
  failures++;
  console.log(`  ${red("✗")} ${label}${detail ? ` ${dim(detail)}` : ""}`);
}
function unknown(label, detail) {
  unknowns++;
  console.log(`  ${yellow("?")} ${label}${detail ? ` ${dim(detail)}` : ""}`);
}
function note(text) {
  console.log(`    ${dim(text)}`);
}
function heading(text) {
  console.log(`\n${bold(text)}`);
}

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

async function getJson(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), NET_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return { data: await r.json() };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timed out" : e.message };
  } finally {
    clearTimeout(t);
  }
}

/** sha256 over every patch file's name + contents — must match apply-patches.mjs. */
function patchSetHash(patchDir, files, stampVersion) {
  const h = crypto.createHash("sha256").update(String(stampVersion));
  for (const f of files) {
    h.update(f);
    h.update(fs.readFileSync(path.join(patchDir, f)));
  }
  return h.digest("hex");
}

export async function verify({ repo, offline = false } = {}) {
  // Reset: the counters are module state, so a second call in one process (a test,
  // or any future programmatic caller) would otherwise inherit the first's verdict.
  failures = 0;
  unknowns = 0;

  const pkg = readJson(path.join(repo, "package.json")) || {};
  const version = pkg.version || "unknown";
  const bundleInfo = readJson(path.join(repo, "BUNDLE_INFO.json"));

  console.log(`\n${bold("⚓ Privateer install check")}  ${dim(`v${version}`)}`);

  // --- 1. what kind of install is this ------------------------------------
  heading("Install");
  if (bundleInfo) {
    pass("self-contained bundle", `${bundleInfo.target || "?"} · pinned Node ${bundleInfo.node || "?"}`);
    note("bundles ship a fixed file set — nothing was resolved on this machine at install time");
  } else {
    pass("npm install", "dependencies were resolved on this machine");
  }
  console.log(`  ${dim("path")}   ${repo}`);
  console.log(`  ${dim("node")}   ${process.version}`);

  // --- 2. is this version the one the registry knows about ----------------
  // The strongest thing checkable from here without re-downloading a tarball:
  // does this exact version exist upstream, and does it carry a provenance
  // attestation? A version the registry has never heard of is the loud case.
  heading("Published provenance");
  if (offline) {
    unknown("skipped (--offline)");
  } else {
    const { data, error } = await getJson(`${REGISTRY}/${pkg.name || "privateer-agent"}/${version}`);
    if (error) {
      unknown("couldn't reach the npm registry", `(${error})`);
      note("re-run with a network connection, or use --offline to skip this section");
    } else if (!data || data.error) {
      fail(`the registry has no ${pkg.name}@${version}`, "this build was not published");
      note("an unpublished version is not automatically malicious — an unreleased local");
      note("checkout looks identical — but a machine you only ever installed from npm");
      note("should never be in this state.");
    } else {
      pass(`published as ${pkg.name}@${version}`);
      const att = data.dist?.attestations;
      if (att?.provenance?.predicateType) {
        pass("carries an npm provenance attestation", att.provenance.predicateType);
        note("verify the signature chain end-to-end with:  npm audit signatures");
      } else {
        fail("no provenance attestation on this version");
        note("every release from 0.6.7 on is published from CI with --provenance;");
        note("a later version without one did not come from that workflow.");
      }
      const npmUser = data._npmUser?.trustedPublisher?.id;
      if (npmUser) pass("published by a trusted publisher", npmUser);
      else if (att) unknown("publisher identity not reported by the registry");
    }
  }

  // --- 3. did the dependency tree drift from what we declared -------------
  // Every direct dependency is pinned to an exact version, precisely so this
  // check can be exact: a resolved version that differs from the declared one
  // means the tree was changed after install.
  heading("Dependencies");
  const deps = Object.entries(pkg.dependencies || {});
  const drift = [];
  const ranged = []; // declared with a range, so there is nothing exact to check against
  let checked = 0;
  let missing = 0;
  for (const [name, want] of deps) {
    const root = findDepRoot(repo, name);
    const manifest = root && readJson(path.join(root, "node_modules", ...name.split("/"), "package.json"));
    if (!manifest) {
      missing++;
      continue;
    }
    // An exact pin is the only thing this check can be exact about. A caret range
    // is not a failure, but counting it as a match would be a lie — it would report
    // "matches its pinned version" for a dependency that has no pinned version.
    if (!/^\d/.test(want)) {
      ranged.push(`${name} ${want} (resolved ${manifest.version})`);
      continue;
    }
    checked++;
    if (manifest.version !== want) drift.push(`${name} ${want} → ${manifest.version}`);
  }
  if (missing) {
    unknown(`${missing} of ${deps.length} direct dependencies not found on disk`);
    note("normal inside a bundle, which flattens its own tree; unexpected for an npm install");
  }
  if (drift.length > 0) {
    fail(`${drift.length} dependenc${drift.length === 1 ? "y differs" : "ies differ"} from the pinned version`);
    for (const d of drift) note(d);
  } else if (checked > 0) {
    pass(`${checked} direct dependenc${checked === 1 ? "y matches its" : "ies match their"} exact pin`);
  }
  if (ranged.length > 0) {
    // Versions before 0.12.9 shipped caret ranges, so an older install lands here.
    unknown(`${ranged.length} direct dependenc${ranged.length === 1 ? "y is" : "ies are"} declared as a range — cannot be checked exactly`);
    for (const d of ranged.slice(0, 5)) note(d);
    if (ranged.length > 5) note(`… and ${ranged.length - 5} more`);
  }

  const piRoot = findDepRoot(repo, "@earendil-works/pi-coding-agent");
  const piPkg =
    piRoot && readJson(path.join(piRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
  if (piPkg) console.log(`  ${dim("runtime")} pi-coding-agent ${piPkg.version}`);

  // --- 4. patch state ------------------------------------------------------
  // Patches are applied at LAUNCH into node_modules, so the running tree is
  // legitimately not byte-identical to the published tarball. That is by design
  // (it is how we avoid an install script), but it means "the files changed" is
  // not by itself a finding — this is the section that says which changes are ours.
  heading("Launch-time patches");
  const patchDir = path.join(repo, "patches");
  const patchFiles = fs.existsSync(patchDir)
    ? fs
        .readdirSync(patchDir)
        .filter((f) => f.endsWith(".patch"))
        .sort()
    : [];
  if (patchFiles.length === 0) {
    pass("none shipped");
  } else {
    const stampFile = piRoot && path.join(piRoot, "node_modules", ".privateer-patches.json");
    const stamp = stampFile && readJson(stampFile);
    // STAMP_VERSION is private to apply-patches.mjs; try the current value and
    // report a mismatch as "stale" rather than guessing at the applier's internals.
    const want = patchSetHash(patchDir, patchFiles, 1);
    if (!stamp) {
      unknown(`${patchFiles.length} patch(es) shipped, none recorded as applied`);
      note("expected before the first launch, or when node_modules is root-owned");
      note("(sudo npm i -g) — Privateer then runs on stock Pi and says so at startup");
    } else if (stamp.hash === want) {
      pass(`${patchFiles.length} patch(es) applied and current`, `at ${stamp.at || "?"}`);
      for (const f of patchFiles) note(f);
    } else {
      unknown("recorded patch set does not match the shipped one", "— will re-apply next launch");
    }
  }

  // --- 5. where config and credentials live -------------------------------
  heading("Config");
  const home = process.env.PRIVATEER_HOME || path.join(process.env.HOME || "", ".privateer");
  console.log(`  ${dim("home")}   ${home}${fs.existsSync(home) ? "" : dim(" (not created yet)")}`);
  for (const d of [".privateer", ".pi"]) {
    const p = path.join(process.cwd(), d);
    if (fs.existsSync(p)) console.log(`  ${dim("project")} ${p}`);
  }

  // --- verdict -------------------------------------------------------------
  console.log("");
  if (failures > 0) {
    console.log(
      red(`✗ ${failures} check(s) failed`) +
        (unknowns ? dim(`, ${unknowns} inconclusive`) : "") +
        "\n" +
        dim("  If you did not expect this, reinstall from a known-good source:\n") +
        dim("    curl -fsSL https://privateer.pro/install.sh | sh\n") +
        dim("  and report it at https://github.com/privateer-agent/privateer-agent/issues"),
    );
    return 1;
  }
  if (unknowns > 0) {
    console.log(yellow(`✓ no failures, ${unknowns} check(s) inconclusive`));
    return 0;
  }
  console.log(green("✓ everything checks out"));
  return 0;
}

// --- CLI -------------------------------------------------------------------
// Guarded, so importing this module (from a test, or from the launcher) does not
// run the command and exit the process out from under the caller.
//
// fileURLToPath, not `new URL(...).pathname`: on Windows the latter yields
// "/C:/Users/..." with percent-encoded spaces, so every path built from it is wrong
// — and win32 is a platform we ship a bundle for.
const HERE = path.dirname(fileURLToPath(import.meta.url));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    const cmd = process.env.PRIVATEER_CMD || "privateer";
    console.log(
      [
        `${cmd} verify — check the Privateer install on this machine.`,
        "",
        `  ${cmd} verify              run every check`,
        `  ${cmd} verify --offline    skip the checks that need the npm registry`,
        "",
        "Reports the install shape, whether this version is published with npm",
        "provenance, whether the dependency tree still matches its pinned versions,",
        "and which launch-time patches are applied.",
      ].join("\n"),
    );
    process.exit(0);
  }
  process.exit(await verify({ repo: path.resolve(HERE, ".."), offline: argv.includes("--offline") }));
}
