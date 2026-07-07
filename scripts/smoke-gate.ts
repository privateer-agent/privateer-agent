// Phase 2 live verify — prove the real permission gate SUSPENDS and blocks a
// live Pi tool_call on deny, and lets it run on allow. Ground truth is a file the
// tool's execute() writes: it appears iff execution was actually permitted.
//
// Run:
//   PRIVATEER_HOME=./tests/fixtures node --env-file=.env --import tsx scripts/smoke-gate.ts

import "../src/boot.ts";

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createSession } from "../src/session.ts";
import { makePermissionGate, type GateController } from "../src/ext/permissionGate.ts";
import type { PermissionRequest } from "../src/permissions/gate.ts";

const WORK = process.env.SMOKE_CWD ?? "/private/tmp/claude-501/pv-gate-work";
const MARKER = path.join(WORK, "gate-marker.txt");

const probe = defineTool({
  name: "gate_probe",
  label: "Gate Probe",
  description: "Writes a marker file. Call this to complete the task.",
  parameters: Type.Object({ note: Type.String() }),
  async execute(_id: string, params: { note: string }) {
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(MARKER, params.note);
    return { content: [{ type: "text", text: `wrote marker: ${params.note}` }], details: {} };
  },
});

async function run(label: string, answer: "allow" | "deny"): Promise<{ asked: boolean; wrote: boolean }> {
  fs.mkdirSync(WORK, { recursive: true });
  try { fs.rmSync(MARKER, { force: true }); } catch {}
  let asked = false;

  const ctrl: GateController = {
    getMode: () => "default",
    setMode: () => {},
    allowlist: [],
    allowedOutsideRoots: [],
    denylist: [],
    cwd: WORK,
    async localAsk(_req: PermissionRequest) {
      asked = true;
      return answer;
    },
  };

  const { session } = await createSession({
    cwd: WORK,
    provider: "openrouter",
    modelId: "openai/gpt-4o-mini",
    extensionFactories: [makePermissionGate(ctrl)],
    customTools: [probe],
    tools: ["gate_probe"],
  });

  await session.prompt("You MUST call the gate_probe tool once with note='hi'. Then reply done.");
  const wrote = fs.existsSync(MARKER);
  console.log(`   ${label}: asked=${asked} marker_written=${wrote}`);
  return { asked, wrote };
}

async function main() {
  console.log("Phase 2 live gate smoke — openrouter/openai/gpt-4o-mini\n");
  console.log("──────── RUN: gate DENIES ────────");
  const deny = await run("deny", "deny");
  console.log("\n──────── RUN: gate ALLOWS ────────");
  const allow = await run("allow", "allow");

  console.log("\n════════ PHASE 2 GATE VERDICT ════════");
  const denyOk = deny.asked && deny.wrote === false; // gate asked, tool blocked
  const allowOk = allow.asked && allow.wrote === true; // gate asked, tool ran
  console.log(`  deny  → asked + tool BLOCKED (no marker) .... ${denyOk ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`  allow → asked + tool RAN (marker written) ... ${allowOk ? "PASS ✅" : "FAIL ❌"}`);
  const pass = denyOk && allowOk;
  console.log(pass
    ? "\n  → the real gate suspends a live tool_call and blocks/permits execution. Phase 2 verified."
    : "\n  → gate did not gate as expected; inspect above.");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("\nGATE SMOKE ERROR:", e?.stack || e);
  process.exit(2);
});
