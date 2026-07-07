// FEASIBILITY SPIKE for the "publish attestation as a Pi extension" idea.
//
// The Phase-3 design installs the undici dispatcher in boot.ts BEFORE any Pi
// import. A marketplace extension can't do that — it loads AFTER pi-ai/undici are
// imported. This spike asks the one load-bearing question: if the dispatcher is
// installed from INSIDE an extension factory (extension-init timing), does it
// still intercept the provider's TLS connection and capture the SPKI?
//
//   YES → a pure one-install `pi-tee` extension is feasible.
//   NO  → the package needs a tiny `import "pkg/boot"` shim users add first.
//
// Deliberately does NOT import ../src/boot.ts (that would install the dispatcher
// early and invalidate the test). Sets the agent dir by hand, installs nothing at
// top level, and makes NO request to the provider host before the extension loads
// (no pre-pooled keep-alive socket, which would skip the connect hook).
//
// Run:
//   PRIVATEER_HOME=./tests/fixtures node --env-file=.env --import tsx scripts/spike-ext-dispatcher.ts

import path from "node:path";
import { fileURLToPath } from "node:url";

// Pin the agent dir WITHOUT boot (so no early dispatcher install).
const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.PI_CODING_AGENT_DIR ??= path.join(
  process.env.PRIVATEER_HOME ?? path.join(HERE, "..", "tests", "fixtures"),
  "agent",
);

// NOTE: importing these pulls in pi-coding-agent (and thus pi-ai/undici) at module
// top level — exactly the "Pi already imported" precondition we're testing under.
const { createSession } = await import("../src/session.ts");
const { installAttestationDispatcher, capturedHosts } = await import(
  "../src/attest/dispatcher.ts"
);

const WORK = "/private/tmp/claude-501/pv-extspike-work";

async function main() {
  console.log("SPIKE — dispatcher installed at EXTENSION-INIT (post-Pi-import)\n");

  // Sanity: nothing installed / captured yet, and no request made to the provider.
  console.log(`  captured before extension load: ${capturedHosts().size}`);

  // The extension: installs the global dispatcher when the resource loader runs it,
  // which is AFTER pi-ai/undici imported but BEFORE the first provider request.
  let extensionRan = false;
  const attestExtension = (_pi: unknown) => {
    installAttestationDispatcher();
    extensionRan = true;
    console.log("  [extension] installAttestationDispatcher() called at init");
  };

  const { session } = await createSession({
    cwd: WORK,
    provider: "openrouter",
    modelId: "openai/gpt-4o-mini",
    extensionFactories: [attestExtension],
  });

  console.log(`  extension ran during load: ${extensionRan}`);
  console.log(`  captured after load, before turn: ${capturedHosts().size}`);

  // Drive a real turn → provider TLS handshake happens now.
  await session.prompt("Reply with exactly the single word: ok");

  const cert = capturedHosts().get("openrouter.ai");
  const intercepted = !!cert && !cert.error;

  console.log("\n════════ EXT-DISPATCHER SPIKE VERDICT ════════");
  console.log(`  extension-init dispatcher intercepted provider TLS ... ${intercepted ? "YES ✅" : "NO ❌"}`);
  if (intercepted) {
    console.log(`  peer subject : ${cert!.subject}`);
    console.log(`  SPKI sha256  : ${cert!.spkiSha256}  ← the value Tinfoil pins`);
    console.log("\n  → PURE pi-tee extension is feasible (no boot shim needed).");
  } else {
    console.log(`  captured hosts: ${[...capturedHosts().keys()].join(", ") || "(none)"}`);
    console.log("\n  → Pi holds a dispatcher captured before extension-init; the");
    console.log("    package needs an `import \"pkg/boot\"` shim installed pre-Pi.");
  }
  process.exit(intercepted ? 0 : 1);
}

main().catch((e) => {
  console.error("\nSPIKE ERROR:", e?.stack || e);
  process.exit(2);
});
