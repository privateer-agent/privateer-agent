#!/usr/bin/env node
// Launcher for the channels runner (Telegram/Slack/Discord/WhatsApp → agent turns).
// Mirrors bin/privateer-harbor.mjs: load dev keys from the repo .env WITHOUT changing
// cwd, register tsx so TS resolves regardless of the invocation cwd, then hand off to
// the channels CLI dispatcher (whose `run` imports ./boot.ts before any Pi code).
//
// Invoked two ways: interactively via the launcher (`privateer channels …`), and by the
// installed launchd/systemd service (`node privateer-channels.mjs run`). This is what
// makes channels runnable from an npm install; it used to need a source checkout
// (`npm run channels`, tsx and a .env).
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

// Same reason as the harbor: channel sessions load the moat in code, so subagent
// children need the moat-injecting wrapper rather than a bare `pi`.
process.env.PI_SUBAGENT_PI_BINARY ??= resolve(repo, "bin/privateer-subagent.mjs");

register();
const { runChannelsCli } = await import(pathToFileURL(resolve(repo, "src/cli/channelsCli.ts")).href);
await runChannelsCli(process.argv.slice(2));
