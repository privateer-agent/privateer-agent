#!/usr/bin/env node
// Privateer launcher. Registers tsx's ESM loader so the TypeScript/JSX
// entrypoint runs with no build step. (Phase 6 can add a compiled binary path.)
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { register } from "tsx/esm/api";

const __dirname = dirname(fileURLToPath(import.meta.url));

register();
await import(resolve(__dirname, "../src/main.tsx"));
