// Phase 3 integration — the whole moat, end-to-end through privateer-agent.
//
// Drives a REAL Tinfoil turn with BOTH the permission gate AND the pi-privacy
// extension loaded, then proves the SPKI captured from Pi's ACTUAL inference
// connection matches Tinfoil's attestation report → verified TEE. This is the
// strongest statement of the moat: the channel the agent actually used ends in
// the attested enclave.
//
// Run:
//   PRIVATEER_HOME=./tests/fixtures node --env-file=.env --import tsx scripts/smoke-integration.ts

import "./../src/boot.ts";

import { createSession } from "../src/session.ts";
import { makePermissionGate, type GateController } from "../src/ext/permissionGate.ts";
import type { EngineEvent } from "../src/engine/events.ts";
import { makePiPrivacyExtension, verifyModelPosture } from "pi-privacy";
import { getCapturedCert, dispatcherTransport } from "pi-privacy/attest";

const CWD = "/private/tmp/claude-501/pv-integration-work";
const PROVIDER = "tinfoil";
const MODEL = "llama3-3-70b";

async function main() {
  console.log("Phase 3 integration — gate + pi-privacy + real Tinfoil turn\n");

  // Allow-all gate (we're proving coexistence + attestation, not the gate policy
  // which Phase 2 already covers).
  const gate: GateController = {
    getMode: () => "bypass",
    setMode: () => {},
    allowlist: [],
    allowedOutsideRoots: [],
    cwd: CWD,
    async localAsk() {
      return "allow";
    },
  };

  let posture: unknown;
  const privacy = makePiPrivacyExtension({
    installDispatcher: true, // idempotent — boot already installed it (same module)
    registerProviders: false, // tinfoil is already in the fixture models.json
    onPosture: (r) => {
      posture = r;
    },
  });

  const events: EngineEvent[] = [];
  const { session, subscribeAsEngineEvents } = await createSession({
    cwd: CWD,
    provider: PROVIDER,
    modelId: MODEL,
    extensionFactories: [makePermissionGate(gate), privacy],
  });
  subscribeAsEngineEvents((ev) => {
    events.push(ev);
    if (ev.type === "text") process.stdout.write(ev.text);
  });

  console.log(`Driving a real ${PROVIDER}/${MODEL} turn…\n`);
  await session.prompt("Reply with exactly the single word: ok");

  // The inference connection to inference.tinfoil.sh has now happened → the
  // dispatcher captured its SPKI. Verify that captured live key against the
  // attestation report (dispatcherTransport reads the per-host capture).
  console.log("\n");
  const cert = getCapturedCert("inference.tinfoil.sh");
  const res = await verifyModelPosture(PROVIDER, MODEL, { transport: dispatcherTransport });

  const gotText = events.some((e) => e.type === "text");
  const gotFinish = events.some((e) => e.type === "finish");
  const captured = !!cert && !cert.error;
  const green = res.tier === "tee-verified" && res.teePosture === "green";

  console.log("════════ INTEGRATION VERDICT ════════");
  console.log(`  real Tinfoil turn produced EngineEvents .......... ${gotText && gotFinish ? "PASS ✅" : "WARN ⚠️"}  [${events.map((e) => e.type).join(", ")}]`);
  console.log(`  dispatcher captured the inference SPKI ........... ${captured ? "PASS ✅" : "FAIL ❌"}`);
  if (captured) console.log(`    inference SPKI: ${cert!.spkiSha256}`);
  console.log(`  posture of the ACTUAL connection = verified TEE .. ${green ? "PASS ✅" : "FAIL ❌"}  (${res.tier}/${res.teePosture ?? "n/a"})`);
  console.log(`  onPosture badge feed fired ...................... ${posture ? "PASS ✅" : "—"}`);

  const pass = captured && green;
  console.log(pass
    ? "\n  → gate + privacy extension + adapter coexist; the connection Pi used for\n    inference is cryptographically verified to end in the Tinfoil enclave."
    : "\n  → integration gap; inspect above.");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("\nINTEGRATION SMOKE ERROR:", e?.stack || e);
  process.exit(2);
});
