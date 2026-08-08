#!/usr/bin/env node
// Launcher for the privateer 0.3 agent REPL. It runs in the DIRECTORY YOU INVOKE
// IT FROM (process.cwd() — that's the agent's working dir), while resolving the
// code and dev keys from the repo. Prefer the `bin/pv` wrapper, which also picks a
// Node >= 22 (the Pi stack's floor).
import { register } from "tsx/esm/api";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

// Dev convenience: load provider keys from the repo's .env if present, WITHOUT
// changing cwd. (A real install would rely on env vars / ~/.privateer instead.)
try {
  process.loadEnvFile(resolve(repo, ".env"));
} catch {
  /* no .env — fall back to the ambient environment */
}

register(); // resolves the repo's tsx regardless of the invocation cwd
// pathToFileURL, NOT the bare path: on Windows an absolute path starts with a
// drive letter, and dynamic import() reads "D:\..." as the URL scheme "d:" —
// ERR_UNSUPPORTED_ESM_URL_SCHEME, before a single line of ours runs. POSIX
// absolute paths happen to work, which is exactly why this survived so long:
// every launcher here had it, and `--version` is intercepted upstream in
// privateer-launch.mjs, so the Windows smoke test booted fine while the actual
// command was dead. Pinned by tests/launcherImports.test.ts.
await import(pathToFileURL(resolve(repo, "src/cli/chat.ts")).href);
