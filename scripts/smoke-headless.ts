// Phase 1 live verify — drive a real headless turn through the boot chain and
// assert the EngineEvent stream shape matches the 0.2 vocabulary.
//
// Run:
//   PRIVATEER_HOME=./tests/fixtures node --env-file=.env --import tsx scripts/smoke-headless.ts
//
// Two legs against a real OpenRouter model (openai/gpt-4o-mini):
//   1. text-only  → expect: text + usage + finish, no error
//   2. tool-call  → expect: tool-call → tool-result ordering (proves the whole adapter)
//
// Nondeterministic (live model), so it asserts structural invariants + ordering,
// not exact strings. Exits nonzero on any failed invariant.

import "../src/boot.ts";

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { EngineEvent } from "../src/engine/events.ts";
import { createSession } from "../src/session.ts";

const PROVIDER = "openrouter";
const MODEL = "openai/gpt-4o-mini";
const CWD = process.env.SMOKE_CWD ?? "/private/tmp/claude-501/pv-smoke-work";

const TURN_TIMEOUT_MS = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function types(events: EngineEvent[]): string[] {
  return events.map((e) => e.type);
}

async function runLeg(
  label: string,
  prompt: string,
  opts: { customTools?: unknown[]; tools?: string[] } = {},
): Promise<EngineEvent[]> {
  console.log(`\n──────── LEG: ${label} ────────`);
  const collected: EngineEvent[] = [];
  const { session, subscribeAsEngineEvents } = await createSession({
    cwd: CWD,
    provider: PROVIDER,
    modelId: MODEL,
    ...opts,
  });
  const unsub = subscribeAsEngineEvents((ev) => {
    collected.push(ev);
    const detail =
      ev.type === "text" ? JSON.stringify(ev.text.slice(0, 40)) :
      ev.type === "reasoning" ? "(thinking)" :
      ev.type === "tool-call" ? `${ev.name} ${JSON.stringify(ev.input).slice(0, 60)}` :
      ev.type === "tool-result" ? `${ev.name} → ${JSON.stringify(ev.output).slice(0, 60)}` :
      ev.type === "tool-error" ? `${ev.name} ✗ ${ev.error}` :
      ev.type === "usage" ? `in=${ev.usage.inputTokens} out=${ev.usage.outputTokens} total=${ev.usage.totalTokens}` :
      ev.type === "finish" ? `reason=${ev.finishReason}` :
      ev.type === "error" ? `ERROR ${ev.error}` : "";
    console.log(`   [EngineEvent] ${ev.type.padEnd(12)} ${detail}`);
  });
  try {
    await withTimeout(session.prompt(prompt), TURN_TIMEOUT_MS, label);
  } finally {
    unsub();
  }
  return collected;
}

async function main() {
  console.log(`Phase 1 live smoke — ${PROVIDER}/${MODEL}`);
  console.log(`  PI_CODING_AGENT_DIR = ${process.env.PI_CODING_AGENT_DIR}`);

  // Leg 1: text only.
  const textEvents = await runLeg(
    "text-only",
    "Reply with exactly the single word: ok",
  );

  // Leg 2: force a tool call with a deterministic custom tool.
  const probe = defineTool({
    name: "smoke_probe",
    label: "Smoke Probe",
    description: "Returns a fixed token. Call this to complete the task.",
    parameters: Type.Object({
      note: Type.String({ description: "any short note" }),
    }),
    async execute(_id: string, params: { note: string }) {
      return {
        content: [{ type: "text", text: `probe-ok:${params.note}` }],
        details: {},
      };
    },
  });
  const toolEvents = await runLeg(
    "tool-call",
    "You MUST call the smoke_probe tool exactly once with note='hi', then reply done.",
    { customTools: [probe], tools: ["smoke_probe"] },
  );

  // ── invariants ──────────────────────────────────────────────────────────
  const t1 = types(textEvents);
  const t2 = types(toolEvents);

  const textOk =
    t1.includes("text") && t1.includes("usage") && t1.includes("finish") && !t1.includes("error");

  const callIdx = t2.indexOf("tool-call");
  const resultIdx = t2.indexOf("tool-result");
  const toolOk =
    callIdx !== -1 &&
    resultIdx !== -1 &&
    callIdx < resultIdx &&
    t2.includes("finish") &&
    !t2.includes("error");

  // usage numbers reachable and nonzero (proves normUsage mapping off real data)
  const usageEv = textEvents.find((e) => e.type === "usage");
  const usageOk = !!usageEv && usageEv.type === "usage" && usageEv.usage.totalTokens > 0;

  console.log("\n════════ PHASE 1 SMOKE VERDICT ════════");
  console.log(`  text leg: text+usage+finish, no error ...... ${textOk ? "PASS ✅" : "FAIL ❌"}  [${t1.join(", ")}]`);
  console.log(`  usage numbers present & nonzero ............ ${usageOk ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`  tool leg: call→result ordered, finish ...... ${toolOk ? "PASS ✅" : "FAIL ❌"}  [${t2.join(", ")}]`);

  const pass = textOk && usageOk && toolOk;
  console.log(pass
    ? "\n  → adapter maps a live turn onto the EngineEvent vocabulary. Phase 1 verified."
    : "\n  → mapping gap — inspect the event lists above against src/bridge/engineAdapter.ts.");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("\nSMOKE ERROR:", e?.stack || e);
  process.exit(2);
});
