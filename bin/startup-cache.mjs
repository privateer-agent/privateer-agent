import fs from "node:fs";
import path from "node:path";

// Set this BEFORE spawning Node: enabling it after importing Pi misses the expensive
// module graph. Node keys bytecode by runtime version and source contents; /reload
// still evaluates fresh modules. This is not Jiti's in-memory module cache.
// Keep it outside the install/project (both may be read-only), under the same home
// as the rest of this Privateer instance. Only code is cached, not session state.
export function configureCompileCache(privateerHome, env = process.env) {
  // Respect Node's own override/opt-out, including an explicitly empty cache path.
  if (env.NODE_COMPILE_CACHE !== undefined || env.NODE_DISABLE_COMPILE_CACHE === "1") return;
  try {
    const dir = path.resolve(privateerHome, "cache", "node-compile");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    env.NODE_COMPILE_CACHE = dir;
  } catch {
    // An unavailable cache must never prevent startup (or print on ACP stdout).
  }
}
