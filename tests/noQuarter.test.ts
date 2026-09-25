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

// The env var IS the state, so clear the flag before loading the module — otherwise
// the assertion below depends on the ambient environment.
delete process.env[ENV];
const { noQuarterActive, setNoQuarter, toggleNoQuarter } = await import("../src/permissions/noQuarter.ts");

// A SECOND instance of the same module. Not a contrivance: Pi loads every extension
// with its own jiti instance and `moduleCache: false`, so extensions/privateer-gate.ts
// and extensions/privateer-privacy.ts each get their own copy of this file. The query
// suffix reproduces that here — two module objects, one session state.
// (the specifier is a variable so tsc doesn't try to resolve the query suffix as a path)
const COPY_SPECIFIER = "../src/permissions/noQuarter.ts?extension-copy";
const copy: typeof import("../src/permissions/noQuarter.ts") = await import(COPY_SPECIFIER);

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

test("a second copy of the module sees the toggle (one state, however many instances)", () => {
  assert.notEqual(copy.noQuarterActive, noQuarterActive, "the copies must really be distinct");
  try {
    setNoQuarter(true);
    assert.equal(copy.noQuarterActive(), true, "an extension that did not toggle must still see no quarter");
    copy.setNoQuarter(false);
    assert.equal(noQuarterActive(), false, "and a toggle from either copy raises the moat for both");
  } finally {
    setNoQuarter(false);
  }
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

// No quarter is also `/privacy off`: a turn left to run unattended must not stall on the
// PII prompt either. Raising the moat restores the filter — but only when no quarter is
// what took it down.
test("no quarter takes the privacy filter down and raising the moat restores it", async () => {
  const { privacyDisabled, setPrivacyDisabled } = await import("../src/config/privacyDisabled.ts");
  setNoQuarter(false);
  setPrivacyDisabled(false);
  try {
    setNoQuarter(true);
    assert.equal(privacyDisabled(), true);
    assert.equal(process.env.PI_PRIVACY_OFF, "1", "subagent children inherit it too");
    copy.setNoQuarter(false); // shift+tab from another extension's copy of the module
    assert.equal(privacyDisabled(), false);
  } finally {
    setNoQuarter(false);
    setPrivacyDisabled(false);
  }
});

test("a filter that was already off stays off when the moat comes back up", async () => {
  const { privacyDisabled, setPrivacyDisabled } = await import("../src/config/privacyDisabled.ts");
  setNoQuarter(false);
  setPrivacyDisabled(true); // `/privacy off` (or --no-privacy) before no quarter
  try {
    setNoQuarter(true);
    setNoQuarter(false);
    assert.equal(privacyDisabled(), true);
  } finally {
    setPrivacyDisabled(false);
  }
});

test("an explicit /privacy mid-no-quarter is the operator's word", async () => {
  const { privacyDisabled, setPrivacyDisabled } = await import("../src/config/privacyDisabled.ts");
  setNoQuarter(false);
  setPrivacyDisabled(false);
  try {
    setNoQuarter(true);
    setPrivacyDisabled(true); // `/privacy off` typed while already off — now it's deliberate
    setNoQuarter(false);
    assert.equal(privacyDisabled(), true, "raising the moat must not overrule an explicit /privacy off");

    setPrivacyDisabled(false);
    setNoQuarter(true);
    setPrivacyDisabled(false); // `/privacy on` during no quarter
    setNoQuarter(false);
    assert.equal(privacyDisabled(), false);
  } finally {
    setNoQuarter(false);
    setPrivacyDisabled(false);
  }
});
