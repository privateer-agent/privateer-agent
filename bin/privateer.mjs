#!/usr/bin/env node
// Privateer launcher. Registers tsx's ESM loader so the TypeScript entrypoint
// runs with no build step, then hands off to src/main.ts.
//
// main.ts imports ./boot.ts FIRST (env + attestation dispatcher) before any Pi
// module is loaded — see the ordering contract documented there.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { register } from "tsx/esm/api";

const __dirname = dirname(fileURLToPath(import.meta.url));

register();
await import(resolve(__dirname, "../src/main.ts"));
