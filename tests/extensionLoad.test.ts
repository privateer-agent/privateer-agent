import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dirname, "..");

// An extension only reaches the user if the launcher knows about it in BOTH places:
// the MANAGED list (which removes the stale shim first) and its own shim() call. Miss
// the shim() and the command never appears; miss MANAGED and a shim from an older
// version lingers pointing at a file that may no longer exist. Nothing else fails when
// you forget — the extension is simply, silently absent — so check it here.
test("launcher: every privateer extension is shimmed and managed", () => {
  const launcher = readFileSync(join(REPO, "bin", "privateer-launch.mjs"), "utf8");
  const files = readdirSync(join(REPO, "extensions"))
    .filter((f) => f.startsWith("privateer-") && f.endsWith(".ts"))
    .map((f) => f.replace(/\.ts$/, ""));

  assert.ok(files.length > 0, "no extensions found — is the path still right?");
  for (const name of files) {
    assert.ok(
      launcher.includes(`"${name}"`),
      `${name} is missing from the launcher's MANAGED list (a stale shim would linger)`,
    );
    assert.ok(
      launcher.includes(`shim("${name}"`),
      `${name} has no shim() call in the launcher, so it never loads`,
    );
  }
});

// Load privateer-connect the way Pi actually does — through the real resource loader
// and the same shim bin/privateer-launch.mjs writes — rather than by importing it with
// tsx like the other tests. Pi resolves extensions through its package manager and
// evaluates each with its OWN jiti instance (moduleCache: false), which is where an
// unresolvable import or a top-level side effect shows up. The unit tests can't see
// that: they import the module directly and would pass regardless.
test("extensions: privateer-connect loads under Pi's real loader and registers /connect", async () => {
  const home = mkdtempSync(join(tmpdir(), "priv-extload-"));
  const agentDir = join(home, "agent");
  const extDir = join(agentDir, "extensions");
  mkdirSync(extDir, { recursive: true });
  // Keep the loaded extension pointed at a throwaway home, not the developer's.
  process.env.PRIVATEER_HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const target = join(REPO, "extensions", "privateer-connect.ts");
    writeFileSync(
      join(extDir, "privateer-connect.ts"),
      `export { default } from ${JSON.stringify(pathToFileURL(target).href)};\n`,
    );

    const { createAgentSessionServices } = await import("@earendil-works/pi-coding-agent");
    const services = await createAgentSessionServices({ cwd: REPO, agentDir });
    const loaded = services.resourceLoader.getExtensions();

    const errors = (loaded.errors ?? []) as Array<{ path?: string; error?: unknown }>;
    assert.equal(errors.length, 0, `extension load errors: ${JSON.stringify(errors)}`);

    const mine = loaded.extensions.filter((e: any) => String(e.path).includes("privateer-connect"));
    assert.equal(mine.length, 1, "privateer-connect did not load");

    // Pi invokes the factory during load, so its registrations are on the record.
    const commands = (mine[0] as any).commands;
    const names = commands instanceof Map ? [...commands.keys()] : Object.keys(commands ?? {});
    assert.ok(names.includes("connect"), `expected /connect, got: ${names.join(", ") || "(none)"}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
