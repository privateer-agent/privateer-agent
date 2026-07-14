#!/usr/bin/env node
// The binary pi-subagents spawns for each subagent child (via PI_SUBAGENT_PI_BINARY)
// when the PARENT loaded privateer's moat as IN-CODE extension factories (the lean
// REPL, the daemon, live task sessions) rather than agent-dir discovery.
//
// Why a wrapper here (vs the plain cli.js the TUI uses): a subagent child is a fresh
// `pi` subprocess that can't inherit the parent's in-code factories. It CAN auto-
// discover agent-dir extensions — but if the parent ALSO loaded those same shims as
// factories, Pi loads both (resource-loader merges discovered + inline) and the moat
// double-loads (two gates, two provider registrations). So instead of relying on
// discovery, this wrapper injects the moat EXPLICITLY as `-e` extensions and passes
// `--no-extensions` to turn agent-dir discovery OFF. The child then loads exactly:
//   • pi-subagents' own runtime extensions (already present in the argv it built), and
//   • privateer's gate + privacy + account (the three `-e` below),
// with no discovery, hence no double-load — while pi-subagents' explicit `--extension`
// args still load (‑‑no‑extensions only disables DISCOVERY, not explicit `-e`).
//
// Exported helpers are pure and unit-tested (tests/subagentWrapper.test.ts); the
// spawn only runs when this file is invoked as a binary.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // bin/
const REPO = resolve(HERE, ".."); // repo root

// Absolute paths to privateer's moat extension entry files (the same modules the TUI
// installs as discovery shims). gate = the permission moat (fail-closed / forwards
// child approvals to the parent); privacy = ZDR/TEE posture + attestation dispatcher;
// account = the privateer/* provider so a child can run account models.
export function moatExtensionPaths(repoRoot = REPO) {
  return [
    join(repoRoot, "extensions", "privateer-gate.ts"),
    join(repoRoot, "extensions", "privateer-privacy.ts"),
    join(repoRoot, "extensions", "privateer-account.ts"),
  ];
}

// The bundled Pi CLI the child actually runs (executable, `#!/usr/bin/env node`).
export function piCliPath(repoRoot = REPO) {
  return join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
}

// Given the args pi-subagents built for the child, return the args to run the bundled
// cli.js with: `--no-extensions` + one `-e <path>` per moat extension, THEN the
// original args (so the injected flags precede the positional `Task:` prompt).
export function buildChildArgs(originalArgs, repoRoot = REPO) {
  const inject = ["--no-extensions"];
  for (const p of moatExtensionPaths(repoRoot)) inject.push("-e", p);
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
