#!/usr/bin/env node
// Launcher for Privateer's ACP surface — the entry an ACP host (Buzz's `buzz-acp`,
// Zed, …) spawns and drives over newline-delimited JSON-RPC on stdio.
//
// Mirrors bin/privateer-harbor.mjs: load dev keys from the repo .env WITHOUT changing
// cwd, register tsx so TS resolves regardless of the invocation cwd, then hand off to
// src/acp/run.ts (which imports ./boot.ts before any Pi code).
//
// ⚠️ THE SPAWN CWD IS THE CONFINEMENT ROOT unless `acp.cwd` is set in
// ~/.privateer/config.json. Whatever directory the host launches this process in is
// what the permission gate confines tools to — the per-session cwd a host sends in
// `session/new` does NOT override it (see the header of src/acp/run.ts). A host that
// spawns from `/` or `$HOME` therefore makes confinement very broad. Set `acp.cwd`
// when the host's spawn directory isn't the project you mean to scope the agent to.
//
// ⚠️ STDOUT IS THE PROTOCOL. Nothing in this process may write non-JSON-RPC bytes to
// stdout — a single stray line breaks the stream and the host disconnects. Note that
// process.loadEnvFile and tsx's register() are both silent; keep it that way, and
// send any diagnostic you add to stderr.
import { register } from "tsx/esm/api";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

try {
  process.loadEnvFile(resolve(repo, ".env"));
} catch {
  /* no .env — rely on the ambient environment / ~/.privateer */
}

// Same reasoning as the harbor: this process loads the moat as in-code factories, so
// subagent children can't inherit it and `pi` isn't on PATH. Point pi-subagents at
// our moat-injecting wrapper so any child spawns gated + private with no double-load.
process.env.PI_SUBAGENT_PI_BINARY ??= resolve(repo, "bin/privateer-subagent.mjs");

register();
const { runAcp } = await import(pathToFileURL(resolve(repo, "src/acp/run.ts")).href);
await runAcp();
