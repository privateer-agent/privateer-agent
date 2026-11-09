import { test } from "node:test";
import assert from "node:assert/strict";
import { FINAL_AUDIT_ENV, needsFinalAudit } from "../src/engine/finalAudit.ts";

// Which runs get the extra turn. The full path runs in tests/oneShotRun.test.ts.

const finished = [
  { role: "user" },
  { role: "assistant", stopReason: "toolUse" },
  { role: "toolResult" },
  { role: "assistant", stopReason: "stop" },
];

test("a headless run that used tools and ended normally is audited", () => {
  assert.equal(needsFinalAudit(finished, "print", {}), true);
  assert.equal(needsFinalAudit(finished, "json", {}), true);
});

test("someone is watching an interactive or RPC run", () => {
  assert.equal(needsFinalAudit(finished, "tui", {}), false);
  assert.equal(needsFinalAudit(finished, "rpc", {}), false);
  assert.equal(needsFinalAudit(finished, undefined, {}), false);
});

test("a subagent's parent reviews its work", () => {
  assert.equal(needsFinalAudit(finished, "json", { PI_SUBAGENT_CHILD: "1" }), false);
});

test("it can be turned off", () => {
  assert.equal(needsFinalAudit(finished, "json", { [FINAL_AUDIT_ENV]: "0" }), false);
});

test("a run that only answered has nothing to audit", () => {
  assert.equal(needsFinalAudit([{ role: "user" }, { role: "assistant", stopReason: "stop" }], "json", {}), false);
});

test("a turn that ended badly is not a finished result", () => {
  for (const stopReason of ["error", "aborted", "length"]) {
    const run = [{ role: "toolResult" }, { role: "assistant", stopReason }];
    assert.equal(needsFinalAudit(run, "json", {}), false, stopReason);
  }
});

test("a host that passes no message list gets no audit", () => {
  assert.equal(needsFinalAudit(undefined, "json", {}), false);
});
