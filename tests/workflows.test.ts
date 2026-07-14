import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

// Throwaway home so the pin + control-ts watermark + workflow files are isolated. Set
// BEFORE importing anything that reads globalDir().
const HOME = mkdtempSync(join(tmpdir(), "privateer-wf-"));
process.env.PRIVATEER_HOME = HOME;

const { authorizeControl } = await import("../src/remote/controlAuth.ts");
const { pinAccountSignKey, clearAccountSignKey } = await import("../src/crypto/accountTrust.ts");
const { makeWorkflowsControl } = await import("../src/remote/workflowsControl.ts");
const { loadWorkflows } = await import("../src/workflows/store.ts");
const { runWorkflow } = await import("../src/workflows/runner.ts");
const { Workflow, newWorkflowId } = await import("../src/workflows/schema.ts");

// Inline replica of the app signer (client/services/accountSign.ts) — same construction
// as controlAuth.test.ts / taskSpawn.test.ts, kept here so any drift in the message that
// gates a workflows_run (script step = RCE) fails this test loudly.
const enc = new TextEncoder();
const KDF_SIGN = enc.encode("privateer-account-sign-v1");
const SIGN_SALT = sha256(enc.encode("privateer-account-sign-salt"));
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}
function seed(mk: Uint8Array) { return hkdf(sha256, mk, SIGN_SALT, KDF_SIGN, 32); }
function pub(mk: Uint8Array) { return Buffer.from(ed25519.getPublicKey(seed(mk))).toString("base64"); }
function sign(mk: Uint8Array, env: { termId: string; ts: number; action: string; args: Record<string, unknown> }) {
  const msg = enc.encode("privateer-control-v1" + canonicalize({ action: env.action, args: env.args, termId: env.termId, ts: env.ts }));
  return Buffer.from(ed25519.sign(msg, seed(mk))).toString("base64");
}

const MK = sha256(enc.encode("test-master-key"));
const TERM = "routines-wf-test";

test.after(() => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

// The graph the daemon's guardControl protects: an agent step routed to a script step.
const DRAFT = {
  workflow: { name: "triage", entry_point: "scan" },
  steps: [
    { name: "scan", type: "agent", prompt: "scan {{ workflow.input.since }}", routes: [{ to: "send" }] },
    { name: "send", type: "script", command: "echo", args: ["done"], routes: [{ to: "$end" }] },
  ],
};

test("workflows_run is verified in STRICT mode — a replayed frame (same ts) is refused", () => {
  pinAccountSignKey(pub(MK));
  const args = { idOrName: "triage" };

  const ts1 = 1000;
  const sig1 = sign(MK, { termId: TERM, ts: ts1, action: "workflows_run", args });
  // First run with a fresh signed ts → accepted.
  assert.equal(authorizeControl(TERM, "workflows_run", args, sig1, ts1, { strict: true }).ok, true);
  // Replaying the SAME signed frame (a malicious relay re-firing an effectful run) → refused,
  // because strict mode rejects ts at-or-below the watermark. The server can't forge a fresh
  // ts (it can't sign), so it can only replay — and every replay is now dead.
  assert.equal(authorizeControl(TERM, "workflows_run", args, sig1, ts1, { strict: true }).ok, false);

  clearAccountSignKey();
});

test("a forged (unsigned / bad-sig) workflows_run is refused fail-closed", () => {
  pinAccountSignKey(pub(MK));
  const args = { idOrName: "triage" };

  // No signature at all.
  assert.equal(authorizeControl(TERM, "workflows_run", args, undefined, 5000, { strict: true }).ok, false);
  // A signature over DIFFERENT args (attacker swapped the target) won't verify.
  const wrongSig = sign(MK, { termId: TERM, ts: 5000, action: "workflows_run", args: { idOrName: "other" } });
  assert.equal(authorizeControl(TERM, "workflows_run", args, wrongSig, 5000, { strict: true }).ok, false);

  clearAccountSignKey();
});

test("workflowsControl.save round-trips and rejects an invalid graph", () => {
  const ctl = makeWorkflowsControl({ runNow: () => {} });

  const created = ctl.save(DRAFT);
  assert.equal(created.ok, true);
  assert.ok(created.id?.startsWith("w-"));
  assert.equal(loadWorkflows().length, 1);

  // A dangling route is rejected at save (validateWorkflow), so a broken graph never persists.
  const bad = ctl.save({ workflow: { name: "broken", entry_point: "a" }, steps: [{ name: "a", type: "agent", prompt: "p", routes: [{ to: "ghost" }] }] });
  assert.equal(bad.ok, false);
  assert.match(bad.message ?? "", /unknown target "ghost"/);
  assert.equal(loadWorkflows().length, 1);

  // Cleanup so a re-run of the suite starts clean.
  ctl.remove(created.id!);
});

test("runner fail-closes a script step when unattended — never executes, defers to outbox", async () => {
  const wf = Workflow.parse({ ...DRAFT, workflow: { ...DRAFT.workflow, id: newWorkflowId() } });
  let scriptRan = false;
  let deferred: string | undefined;

  const result = await runWorkflow(wf, { since: "12h" }, {
    runAgent: async () => ({ text: "ok", output: {}, status: "ok" }),
    runScript: async () => { scriptRan = true; return { output: {}, status: "ok", exitCode: 0 }; },
    askGate: async () => "approve",
    attended: () => false, // no controller driving
    deferForApproval: async (reason) => { deferred = reason; },
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(result.status, "deferred");
  assert.equal(scriptRan, false, "an unattended script step must NOT execute");
  assert.ok(deferred && /approval required/i.test(deferred), "the run seals a needs-approval notice");
});

test("runner runs the script when attended AND approved", async () => {
  const wf = Workflow.parse({ ...DRAFT, workflow: { ...DRAFT.workflow, id: newWorkflowId() } });
  let scriptRan = false;

  const result = await runWorkflow(wf, { since: "12h" }, {
    runAgent: async () => ({ text: "ok", output: {}, status: "ok" }),
    runScript: async () => { scriptRan = true; return { output: { ok: true }, status: "ok", exitCode: 0 }; },
    askGate: async () => "approve", // account approves the script
    attended: () => true,
    deferForApproval: async () => {},
    sleep: async () => {},
    log: () => {},
  });

  assert.equal(result.status, "success");
  assert.equal(scriptRan, true);
});
