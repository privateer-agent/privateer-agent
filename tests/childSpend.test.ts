import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHILD_SPEND_ENV,
  grantChildSpend,
  resetChildSpend,
  inheritedChildSpend,
  childSpendAllows,
  childHoldsSpendGrant,
} from "../src/permissions/childSpend.ts";

// Handing an unattended run's spend authorization down to its subagent children. The
// value travels through the environment (a child is a separate process), so these tests
// own and restore the two env vars involved rather than trusting the ambient ones.

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const asChild = (fn: () => void) => withEnv({ PI_SUBAGENT_CHILD: "1" }, fn);

test("a grant is published to the environment and released with the run", () => {
  resetChildSpend();
  try {
    const release = grantChildSpend("run:1", ["generate_sfx", "generate_music"]);
    assert.equal(process.env[CHILD_SPEND_ENV], "generate_music,generate_sfx", "sorted, so the value is stable");
    release();
    assert.equal(process.env[CHILD_SPEND_ENV], undefined, "a released grant leaves nothing behind for the next run");
  } finally {
    resetChildSpend();
  }
});

test("a run with no media grant advertises nothing", () => {
  resetChildSpend();
  try {
    const release = grantChildSpend("run:1", []);
    assert.equal(process.env[CHILD_SPEND_ENV], undefined);
    release();
    grantChildSpend("run:2", undefined)();
    assert.equal(process.env[CHILD_SPEND_ENV], undefined);
  } finally {
    resetChildSpend();
  }
});

// THE concurrency case. The harbor daemon can have a scheduled routine and a submitted
// task in flight at once, and children read one process-wide variable when they spawn.
// The union would let run B's child spend on a tool only run A was granted; the
// intersection can only ever narrow, which fails closed with the gate's ordinary denial.
test("overlapping runs narrow to what they share, never widen", () => {
  resetChildSpend();
  try {
    const releaseA = grantChildSpend("run:A", ["generate_sfx", "generate_music", "generate_image"]);
    const releaseB = grantChildSpend("run:B", ["generate_sfx", "generate_video"]);
    assert.equal(process.env[CHILD_SPEND_ENV], "generate_sfx", "only the tool BOTH runs were granted");

    // When the narrower run finishes, the survivor's own grant is restored in full.
    releaseB();
    assert.equal(process.env[CHILD_SPEND_ENV], "generate_image,generate_music,generate_sfx");
    releaseA();
    assert.equal(process.env[CHILD_SPEND_ENV], undefined);
  } finally {
    resetChildSpend();
  }
});

test("two runs sharing nothing advertise nothing at all", () => {
  resetChildSpend();
  try {
    grantChildSpend("run:A", ["generate_image"]);
    grantChildSpend("run:B", ["generate_music"]);
    assert.equal(process.env[CHILD_SPEND_ENV], undefined, "no shared tool → no grant, not both");
  } finally {
    resetChildSpend();
  }
});

// The reason the child side checks PI_SUBAGENT_CHILD: a stray PRIVATEER_CHILD_SPEND in a
// developer's shell must never turn a TERMINAL into a session that bills without asking.
test("the grant is honoured only inside a subagent child", () => {
  withEnv({ [CHILD_SPEND_ENV]: "generate_video", PI_SUBAGENT_CHILD: undefined }, () => {
    assert.deepEqual([...inheritedChildSpend()], [], "a top-level session ignores the env entirely");
    assert.equal(childSpendAllows("generate_video"), false);
    assert.equal(childHoldsSpendGrant(), false);
  });
  withEnv({ [CHILD_SPEND_ENV]: "generate_video" }, () =>
    asChild(() => {
      assert.deepEqual([...inheritedChildSpend()], ["generate_video"]);
      assert.equal(childSpendAllows("generate_video"), true);
      assert.equal(childSpendAllows("generate_music"), false, "the grant is per name");
      assert.equal(childHoldsSpendGrant(), true);
    }),
  );
});

test("a child with no grant holds none", () => {
  withEnv({ [CHILD_SPEND_ENV]: undefined }, () =>
    asChild(() => {
      assert.equal(childHoldsSpendGrant(), false);
      assert.equal(childSpendAllows("generate_sfx"), false);
    }),
  );
});

test("a malformed grant parses to the names it does contain", () => {
  // Whitespace and empty entries are what a hand-set env or a future join bug produces;
  // neither should make a valid name unreadable, and neither can invent one.
  withEnv({ [CHILD_SPEND_ENV]: " generate_sfx , ,, generate_music " }, () =>
    asChild(() => {
      assert.deepEqual([...inheritedChildSpend()].sort(), ["generate_music", "generate_sfx"]);
      assert.equal(childSpendAllows(""), false);
    }),
  );
});
