#!/usr/bin/env node
// Launcher for the resident Privateer harbor (routines + app-driven headless task
// spawns). Mirrors bin/privateer.mjs: load dev keys from the repo .env WITHOUT
// changing cwd, register tsx so TS resolves regardless of the invocation cwd, then
// hand off to the harbor CLI dispatcher (which imports ./boot.ts before any Pi code).
//
// Invoked two ways: interactively via the bash launcher (`privateer harbor …`), and
// by the installed launchd/systemd service (`node privateer-harbor.mjs run`).
import { register } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

try {
  process.loadEnvFile(resolve(repo, ".env"));
} catch {
  /* no .env — rely on the ambient environment / ~/.privateer */
}

// The harbor loads the moat as in-code factories, so its subagent children (routines /
// task sessions) can't inherit it and `pi` isn't on PATH. Point pi-subagents at our
// moat-injecting wrapper so those children spawn gated + private with no double-load.
// Process-global is safe here: the wrapper is stateless (unlike a per-parent channel).
process.env.PI_SUBAGENT_PI_BINARY ??= resolve(repo, "bin/privateer-subagent.mjs");

register();
const { runHarborCli } = await import(resolve(repo, "src/cli/harborCli.ts"));
await runHarborCli(process.argv.slice(2));
