import { test } from "node:test";
import assert from "node:assert/strict";
import { ModeGate } from "../src/permissions/modeGate.ts";
import { DEFAULT_DENYLIST } from "../src/permissions/danger.ts";
import type { PermissionRequest } from "../src/permissions/gate.ts";

// The session no-quarter state behind shift+tab (extensions/privateer-gate.ts) and
// `/no-quarter`, plus the `--no-quarter` launch flag. tests/permissions.test.ts
// already covers what getSkipAllPermissions does to a decision; this covers the
// state itself — that it seeds from the launch flag, mirrors back to the env so
// subagent children inherit it, and can be flipped MID-SESSION (the point of the
// keybinding: walk away and the running agent stops asking).

const ENV = "PRIVATEER_NO_QUARTER";

// The module seeds `active` from the env at import time, so clear the flag before
// loading it — otherwise the assertion below depends on the ambient environment.
delete process.env[ENV];
const { noQuarterActive, setNoQuarter, toggleNoQuarter } = await import("../src/permissions/noQuarter.ts");

const edit: PermissionRequest = { tool: "edit", kind: "edit", title: "Edit file", detail: "a.ts" };
const bash = (cmd: string): PermissionRequest => ({ tool: "bash", kind: "bash", title: "Run", detail: cmd });

test("off without the launch flag", () => {
  assert.equal(noQuarterActive(), false);
});

test("toggling mirrors the env, so subagent children inherit the posture", () => {
  assert.equal(toggleNoQuarter(), true);
  assert.equal(noQuarterActive(), true);
  assert.equal(process.env[ENV], "1"); // a child `pi` reads this and lowers its own gate

  assert.equal(toggleNoQuarter(), false);
  assert.equal(noQuarterActive(), false);
  assert.equal(process.env[ENV], undefined); // and stops inheriting it once raised
});

test("setNoQuarter is idempotent and explicit", () => {
  setNoQuarter(true);
  setNoQuarter(true);
  assert.equal(noQuarterActive(), true);
  setNoQuarter(false);
  assert.equal(noQuarterActive(), false);
});

test("a live gate follows the toggle mid-session", async () => {
  let asks = 0;
  let mode: "default" | "acceptEdits" | "bypass" | "plan" = "default";
  const gate = new ModeGate({
    getMode: () => mode,
    setMode: (m) => (mode = m),
    allowlist: [],
    allowedOutsideRoots: [],
    denylist: DEFAULT_DENYLIST,
    ask: async () => {
      asks++;
      return "deny";
    },
    getSkipAllPermissions: noQuarterActive, // exactly how the gate is wired
  });

  setNoQuarter(false);
  assert.equal(await gate.request(edit), "deny"); // prompts, and the user said no
  assert.equal(asks, 1);

  // shift+tab — from here the agent runs unattended.
  setNoQuarter(true);
  assert.equal(await gate.request(edit), "allow");
  assert.equal(await gate.request(bash("rm -rf /")), "allow"); // even dangerous shell
  assert.equal(asks, 1); // no further prompt

  // shift+tab again — the moat comes straight back up.
  setNoQuarter(false);
  assert.equal(await gate.request(edit), "deny");
  assert.equal(asks, 2);
});
