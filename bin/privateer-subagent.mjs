#!/usr/bin/env node
// The binary pi-subagents spawns for EVERY subagent child (via PI_SUBAGENT_PI_BINARY).
//
// ⚠️ THIS IS WHAT KEEPS A SUBAGENT GATED. A child is a fresh `pi` subprocess that cannot
// inherit its parent's in-code extension factories, and — since the moat stopped being
// installed as discovery shims in the shared agent dir — there is nothing for it to
// discover either. So the moat reaches a child through exactly one route: the `-e` args
// injected here. A child spawned around this wrapper runs UNGATED.
//
// It also passes `--no-extensions` to turn agent-dir discovery off. That is now about the
// child's blast radius rather than double-loading: an unattended, headless worker should
// load the set its parent chose and nothing else — not whatever extensions the user
// happens to have configured for their own interactive sessions. (`--no-extensions`
// disables DISCOVERY only, so pi-subagents' own `--extension` args still load, as do the
// `-e` paths below.)
//
// Exported helpers are pure and unit-tested (tests/subagentWrapper.test.ts); the
// spawn only runs when this file is invoked as a binary.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, delimiter } from "node:path";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url)); // bin/
const REPO = resolve(HERE, ".."); // repo root

// The moat a child loads: whatever its PARENT loaded, handed down through the environment.
//
// bin/privateer-launch.mjs sets PRIVATEER_CHILD_EXTENSIONS to the same list it passes the
// TUI, so a child of a terminal gets the terminal's moat — including the tool packs —
// rather than a hardcoded subset that silently drifts from it as the manifest changes.
//
// The fallback covers the in-code parents (the lean REPL, the harbor, live task sessions),
// which build their moat from factories and have no `-e` list to hand down. Those get the
// floor and nothing else: gate = the permission moat (fail-closed, forwards the child's
// approvals to the parent); privacy = ZDR/TEE posture + attestation dispatcher; account =
// the privateer/* provider, so a child can run account models.
//
// media is here for the work an unattended run most wants to delegate — a film is a
// per-shot job, and a shot per subagent is the shape that fits. It is SAFE to list
// unconditionally because the extension shapes itself rather than trusting its position
// on this list: video_compose (local ffmpeg, no spend) always registers, and the billing
// generate_* tools register only when the parent handed this child an explicit spend
// grant. See extensions/privateer-media.ts and src/permissions/childSpend.ts. Still
// narrower than a terminal's list — no web, no MCP, no brand/hints/update surface.
export function moatExtensionPaths(repoRoot = REPO, env = process.env) {
  const inherited = (env.PRIVATEER_CHILD_EXTENSIONS ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter((p) => p && existsSync(p));
  if (inherited.length > 0) return inherited;
  return [
    join(repoRoot, "extensions", "privateer-gate.ts"),
    join(repoRoot, "extensions", "privateer-privacy.ts"),
    join(repoRoot, "extensions", "privateer-account.ts"),
    join(repoRoot, "extensions", "privateer-media.ts"),
  ];
}

// The bundled Pi CLI the child actually runs (executable, `#!/usr/bin/env node`).
export function piCliPath(repoRoot = REPO) {
  return join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
}

// Given the args pi-subagents built for the child, return the args to run the bundled
// cli.js with: `--no-extensions` + one `-e <path>` per moat extension, THEN the
// original args (so the injected flags precede the positional `Task:` prompt).
export function buildChildArgs(originalArgs, repoRoot = REPO, env = process.env) {
  const inject = ["--no-extensions"];
  for (const p of moatExtensionPaths(repoRoot, env)) inject.push("-e", p);
  return [...inject, ...originalArgs];
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = buildChildArgs(process.argv.slice(2));
  const child = spawn(process.execPath, [piCliPath(), ...args], { stdio: "inherit", env: process.env });
  // Propagate the child's exit faithfully so pi-subagents' parent reads the real
  // outcome (a signal re-raises; otherwise exit with the same code).
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  child.on("error", (e) => {
    console.error(`privateer-subagent: failed to spawn pi — ${e.message}`);
    process.exit(1);
  });
}
