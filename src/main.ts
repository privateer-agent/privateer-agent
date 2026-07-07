// Entrypoint. The ONE ordering rule: import ./boot.ts first (env +
// attestation dispatcher), then dynamically import everything Pi-touching so
// boot's side effects are guaranteed to have run before any Pi module loads.
//
// Phase 1 skeleton: this prints the resolved boot state so `npm start` proves
// the boot chain end-to-end (env pinned, dispatcher installed) without a TUI.
// Phases 4/6 replace the body with the daemon/relay wiring and the pi-tui app.

import "./boot.ts";

async function main() {
  // Only import Pi-touching / config code AFTER boot has run.
  const { agentDir, globalDir } = await import("./config/paths.ts");
  const { capturedHosts } = await import("./attest/dispatcher.ts");

  const home = globalDir();
  const agent = process.env.PI_CODING_AGENT_DIR ?? agentDir();

  console.log("privateer-agent 0.3 — boot skeleton");
  console.log(`  PRIVATEER_HOME        ${home}`);
  console.log(`  PI_CODING_AGENT_DIR   ${agent}`);
  console.log(`  attestation dispatcher installed: yes`);
  console.log(`  hosts attested so far: ${capturedHosts().size}`);
  console.log("");
  console.log("Phases 1–2 skeleton in place (adapter + gate promoted from pi-spike).");
  console.log("Next: wire a real headless session — see docs/pi-migration-plan.md §2.");
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
