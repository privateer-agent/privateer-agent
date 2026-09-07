// GUI control: the coordinate contract, the permission policy, and the arm switch.
//
// Run: node --import tsx --test tests/computer.test.ts
//
// The first block is the one that earns its keep. A mis-scaled click does not throw and
// does not fail a build — it lands somewhere plausible, the model sees a screenshot
// where nothing happened, and it tries again. So the round trip is pinned over the
// display shapes that actually ship rather than the one on the developer's desk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_MAX_EDGE,
  MAX_MAX_EDGE,
  MIN_MAX_EDGE,
  agentToDevice,
  clampMaxEdge,
  describeDisplays,
  deviceToAgent,
  isInFrame,
  planCapture,
  resolveDisplay,
  type Display,
} from "../src/computer/space.ts";
import { classifyToolCall } from "../src/permissions/classify.ts";
import { decideAuto } from "../src/permissions/mode.ts";
import { computerControlArmed, COMPUTER_CONTROL_ENV } from "../src/config/computerControl.ts";
import { COMPUTER_TOOL_NAMES } from "../src/tools/computer.ts";

// The panels this has to be right on: a 2× laptop, a plain 1× monitor, an ultrawide, a
// 2× display placed above-left of the primary (negative origin), and one small enough
// that it must not be upscaled. The origins are in POINTS and are informational — every
// coordinate the mapping produces is local to one display (see Display.originX).
const DISPLAYS: Display[] = [
  { id: "1", label: "Built-in Retina Display", width: 3456, height: 2234, scale: 2, originX: 0, originY: 0, primary: true },
  { id: "2", label: "DELL U2720Q", width: 2560, height: 1440, scale: 1, originX: 3456, originY: 0, primary: false },
  { id: "3", label: "LG UltraWide", width: 5120, height: 1440, scale: 1, originX: -5120, originY: 0, primary: false },
  { id: "4", label: "Sidecar iPad", width: 2360, height: 1640, scale: 2, originX: 0, originY: -1640, primary: false },
  { id: "5", label: "Small panel", width: 1024, height: 768, scale: 1, originX: 0, originY: 2234, primary: false },
];

const scope = { cwd: "/tmp/work" };

test("agent space never exceeds the requested max edge, and small displays are not upscaled", () => {
  for (const d of DISPLAYS) {
    const plan = planCapture(d, DEFAULT_MAX_EDGE);
    assert.ok(
      Math.max(plan.width, plan.height) <= DEFAULT_MAX_EDGE,
      `${d.label}: ${plan.width}×${plan.height} exceeds ${DEFAULT_MAX_EDGE}`,
    );
    // Never bigger than the panel: paying tokens for invented pixels.
    assert.ok(plan.width <= d.width && plan.height <= d.height, `${d.label} was upscaled`);
  }
  // The small panel is passed through untouched.
  const small = planCapture(DISPLAYS[4], DEFAULT_MAX_EDGE);
  assert.equal(small.width, 1024);
  assert.equal(small.height, 768);
  assert.equal(small.factorX, 1);
  assert.equal(small.factorY, 1);
});

test("every point in agent space round-trips back to itself", () => {
  // THE invariant. If this breaks, clicks drift toward the far edge of the screen and
  // nothing anywhere reports an error.
  for (const d of DISPLAYS) {
    for (const edge of [MIN_MAX_EDGE, 640, DEFAULT_MAX_EDGE, MAX_MAX_EDGE]) {
      const plan = planCapture(d, edge);
      const xs = [0, 1, Math.floor(plan.width / 3), Math.floor(plan.width / 2), plan.width - 2, plan.width - 1];
      const ys = [0, 1, Math.floor(plan.height / 3), Math.floor(plan.height / 2), plan.height - 2, plan.height - 1];
      for (const x of xs) {
        for (const y of ys) {
          if (x < 0 || y < 0) continue;
          const back = deviceToAgent(agentToDevice({ x, y }, plan), plan);
          assert.deepEqual(back, { x, y }, `${d.label} @${edge}: (${x},${y}) came back as (${back.x},${back.y})`);
        }
      }
    }
  }
});

test("the round trip is exact for EVERY pixel, not just sampled ones", () => {
  // The sampled test above would pass with a mapping that is off by one over some
  // interior band — which is exactly how the first two attempts at cellDevice failed
  // (one overshot only at the far edge, the other was wrong across most of the screen).
  // Sweeping every row and column of every display is a few hundred thousand cheap
  // integer operations and turns "probably right" into "right".
  for (const d of DISPLAYS) {
    for (const edge of [MIN_MAX_EDGE, DEFAULT_MAX_EDGE, MAX_MAX_EDGE]) {
      const plan = planCapture(d, edge);
      for (let x = 0; x < plan.width; x++) {
        const back = deviceToAgent(agentToDevice({ x, y: 0 }, plan), plan);
        assert.equal(back.x, x, `${d.label} @${edge}: column ${x} came back as ${back.x}`);
      }
      for (let y = 0; y < plan.height; y++) {
        const back = deviceToAgent(agentToDevice({ x: 0, y }, plan), plan);
        assert.equal(back.y, y, `${d.label} @${edge}: row ${y} came back as ${back.y}`);
      }
    }
  }
});

test("a device point from any agent point lands strictly inside its own display", () => {
  // The off-by-one that puts a click one row past the menu bar — and, before the space
  // was made display-local, on the wrong monitor entirely.
  for (const d of DISPLAYS) {
    const plan = planCapture(d, DEFAULT_MAX_EDGE);
    for (const [x, y] of [
      [0, 0],
      [plan.width - 1, 0],
      [0, plan.height - 1],
      [plan.width - 1, plan.height - 1],
    ]) {
      const p = agentToDevice({ x, y }, plan);
      assert.ok(p.x >= 0 && p.x < d.width, `${d.label}: x ${p.x} outside [0, ${d.width})`);
      assert.ok(p.y >= 0 && p.y < d.height, `${d.label}: y ${p.y} outside [0, ${d.height})`);
    }
  }
});

test("an out-of-frame coordinate throws instead of being clamped", () => {
  // Clamping would put the pointer at the nearest edge — a plausible place that is not
  // where the model aimed — and the model would misread the result as the click having
  // done something unexpected rather than as its own coordinates being wrong.
  const plan = planCapture(DISPLAYS[0], DEFAULT_MAX_EDGE);
  for (const bad of [
    { x: -1, y: 0 },
    { x: 0, y: -1 },
    { x: plan.width, y: 0 },
    { x: 0, y: plan.height },
    { x: Number.NaN, y: 0 },
  ]) {
    assert.throws(() => agentToDevice(bad, plan), RangeError, `(${bad.x},${bad.y}) should be rejected`);
    assert.equal(isInFrame(bad, plan), false);
  }
});

test("max_edge is clamped, and a nonsense value falls back to the default", () => {
  assert.equal(clampMaxEdge(undefined), DEFAULT_MAX_EDGE);
  assert.equal(clampMaxEdge(Number.NaN), DEFAULT_MAX_EDGE);
  assert.equal(clampMaxEdge(10), MIN_MAX_EDGE);
  assert.equal(clampMaxEdge(99999), MAX_MAX_EDGE);
  assert.equal(clampMaxEdge(900), 900);
});

test("display resolution prefers the named one, then the primary", () => {
  assert.equal(resolveDisplay(DISPLAYS, "3")?.label, "LG UltraWide");
  assert.equal(resolveDisplay(DISPLAYS, undefined)?.id, "1");
  assert.equal(resolveDisplay(DISPLAYS, "nope"), undefined);
  assert.equal(resolveDisplay([], undefined), undefined);
  // With no primary flagged, the first is used rather than nothing.
  const none = DISPLAYS.map((d) => ({ ...d, primary: false }));
  assert.equal(resolveDisplay(none, undefined)?.id, "1");
});

test("the capability listing tells the model the space it must use, not the device size", () => {
  const lines = describeDisplays([DISPLAYS[0]]);
  assert.match(lines[0], /3456×2234 device px/);
  assert.match(lines[0], /you will see it as \d+×\d+/);
  // The agent-space size quoted must be the one planCapture actually produces.
  const plan = planCapture(DISPLAYS[0], DEFAULT_MAX_EDGE);
  assert.match(lines[0], new RegExp(`see it as ${plan.width}×${plan.height}`));
});

// ─── Permission policy ───────────────────────────────────────────────────────

test("computer actions never auto-approve — in any mode, including bypass", () => {
  // The whole safety story rests on this. A coordinate is the one input nothing in
  // classify.ts can judge, so the human has to.
  const req = { tool: "computer_control", kind: "computer" as const, title: "Click", detail: "at 10,10" };
  assert.equal(decideAuto(req, "default", [], []), "ask");
  assert.equal(decideAuto(req, "acceptEdits", [], []), "ask");
  assert.equal(decideAuto(req, "bypass", [], []), "ask");
  // Plan mode is read-only: a click mutates the world, so it is refused outright rather
  // than asked about.
  assert.equal(decideAuto(req, "plan", [], []), "deny");
  // An allowlist entry cannot reach it either — allowlisting is a bash mechanism.
  assert.equal(decideAuto(req, "bypass", ["computer_control"], []), "ask");
});

test("the other kinds are unchanged by the new one", () => {
  // Guards the edit in mode.ts: inserting a branch above `bypass` must not have moved
  // anything else's answer.
  assert.equal(decideAuto({ tool: "bash", kind: "bash", title: "", detail: "ls" }, "bypass", [], []), "allow");
  assert.equal(decideAuto({ tool: "write", kind: "write", title: "", detail: "" }, "acceptEdits", [], []), "allow");
  assert.equal(decideAuto({ tool: "read", kind: "read", title: "", detail: "" }, "default", [], []), "ask");
});

test("classify gives every computer action a prompt a human can decide about", () => {
  const c = (input: unknown) => classifyToolCall("computer_control", input, scope);

  const click = c({ action: "click", x: 812, y: 344, display: "1" })!;
  assert.equal(click.kind, "computer");
  assert.equal(click.title, "Click the mouse");
  assert.match(click.detail, /812,344/);
  assert.match(click.detail, /display 1/);

  // Typing must show WHAT it types — approving a keystroke you cannot see is approving
  // nothing — and must not be truncated, or the tail is unapproved.
  const long = "x".repeat(500);
  const typed = c({ action: "type", text: long })!;
  assert.equal(typed.kind, "computer");
  assert.ok(typed.detail.includes(long), "the typed text must appear in full");

  assert.equal(c({ action: "key", keys: "cmd+s" })!.title, "Press a key combination");
  assert.match(c({ action: "key", keys: "cmd+s" })!.detail, /cmd\+s/);
  assert.equal(c({ action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 })!.title, "Drag the mouse");
  assert.equal(c({ action: "right_click", x: 1, y: 2 })!.title, "Right-click the mouse");
  assert.equal(c({ action: "double_click", x: 1, y: 2 })!.title, "Double-click the mouse");
  assert.equal(c({ action: "move", x: 1, y: 2 })!.title, "Move the mouse");
  assert.equal(c({ action: "scroll", x: 1, y: 2, scroll_y: -3 })!.title, "Scroll");
  assert.equal(c({ action: "wait", ms: 500 })!.title, "Wait");

  // An unrecognised action still gates, rather than falling through to a branch that
  // might judge it more leniently.
  const weird = c({ action: "teleport" })!;
  assert.equal(weird.kind, "computer");
  assert.match(weird.detail, /unrecognised/);
});

test("screen_capture gates as a computer action and says what it exposes", () => {
  const req = classifyToolCall("screen_capture", { display: "2" }, scope)!;
  assert.equal(req.kind, "computer");
  assert.match(req.detail, /display 2/);
  // A screenshot is a disclosure of whatever is on screen, and the prompt has to say so
  // — the user may have a password manager or someone else's message in front.
  assert.match(req.detail, /sent to the model/);
});

test("computer_capabilities is a read, so it never moves anything", () => {
  const req = classifyToolCall("computer_capabilities", {}, scope)!;
  assert.equal(req.kind, "read");
  assert.match(req.detail, /moves nothing/);
});

// ─── The arm switch ──────────────────────────────────────────────────────────

test("screen control is off unless explicitly armed, and a typo fails closed", () => {
  const original = process.env[COMPUTER_CONTROL_ENV];
  try {
    delete process.env[COMPUTER_CONTROL_ENV];
    assert.equal(computerControlArmed(), false, "unset must be OFF");
    for (const v of ["", "  ", "0", "false", "off", "no", "ture", "yes please", "maybe"]) {
      process.env[COMPUTER_CONTROL_ENV] = v;
      assert.equal(computerControlArmed(), false, `"${v}" must not arm the machine`);
    }
    for (const v of ["1", "true", "on", "yes", "TRUE", " On "]) {
      process.env[COMPUTER_CONTROL_ENV] = v;
      assert.equal(computerControlArmed(), true, `"${v}" should arm`);
    }
  } finally {
    if (original === undefined) delete process.env[COMPUTER_CONTROL_ENV];
    else process.env[COMPUTER_CONTROL_ENV] = original;
  }
});

test("every registered tool name is classified, and every classified name is registered", () => {
  // The drift this catches: a tool added to computer.ts but not to classify.ts falls
  // through to the unknown-tool branch, which calls it bash-kind — and bash-kind is
  // auto-approvable under bypass and by the allowlist. A GUI action would then run
  // without a prompt.
  for (const name of COMPUTER_TOOL_NAMES) {
    const req = classifyToolCall(name, { action: "click", x: 0, y: 0 }, scope);
    assert.ok(req, `${name} must classify`);
    assert.ok(
      req!.kind === "computer" || req!.kind === "read",
      `${name} classified as ${req!.kind} — a GUI tool must never be bash-kind`,
    );
  }
  assert.deepEqual([...COMPUTER_TOOL_NAMES], ["computer_capabilities", "screen_capture", "computer_control"]);
});

// ─── Helper resolution ───────────────────────────────────────────────────────
//
// Three platforms, three SHAPES of helper, and the difference is the platform's own:
// macOS needs a compiled binary (CGEvent has no scriptable equivalent), Windows is a
// PowerShell script, Linux is a Node script. The scripts ship inside this package, so
// the CLI gets screen control on those two platforms; the mac binary ships with the
// desktop app and the CLI does not carry it.
//
// Worth testing because the failure is silent in a specific way: hand `spawn` a .ps1 as
// though it were an executable and you get ENOEXEC (or, worse on some systems, the
// user's default editor), which surfaces as "screen control is unavailable" — the same
// message a missing helper produces, and the same one a missing macOS grant produces.

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findHelper, HELPER_PATH_ENV } from "../src/computer/helper.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function withPlatform<T>(platform: string, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const original = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

test("the Windows and Linux helpers ship inside this package", () => {
  // They are resolved relative to this module, so they have to BE here — and they have
  // to be in package.json's `files`, or the npm build silently drops screen control on
  // both platforms while every test that resolves them from the repo still passes.
  assert.ok(existsSync(join(REPO_ROOT, "native/win/PrivateerComputer.ps1")), "the Windows helper is missing");
  assert.ok(existsSync(join(REPO_ROOT, "native/linux/privateer-computer.mjs")), "the Linux helper is missing");

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("native"), "package.json `files` must publish native/, or npm drops both helpers");
});

test("Windows resolves to PowerShell running the script, not the script as a binary", () => {
  withEnv(HELPER_PATH_ENV, undefined, () => {
    withPlatform("win32", () => {
      const serve = findHelper("serve");
      assert.ok(serve, "a win32 machine should resolve a helper");
      assert.equal(serve!.command, "powershell.exe");
      assert.ok(serve!.args.includes("-File"), "must run the script by -File");
      assert.ok(serve!.args.some((a) => a.endsWith("PrivateerComputer.ps1")));
      assert.ok(serve!.args.includes("-Serve"), "serve mode must reach the script");
      // -NoProfile keeps a user's profile from printing into the protocol stream, and
      // Bypass is required because the default policy refuses unsigned local scripts.
      assert.ok(serve!.args.includes("-NoProfile"));
      assert.ok(serve!.args.includes("Bypass"));

      // The two modes must differ, or the desktop's grants probe would start a serve
      // loop that never answers and time out at four seconds every poll.
      const grants = findHelper("grants");
      assert.ok(grants!.args.includes("-Grants"));
      assert.ok(!grants!.args.includes("-Serve"));
    });
  });
});

test("Linux resolves to Node running the script", () => {
  withEnv(HELPER_PATH_ENV, undefined, () => {
    withPlatform("linux", () => {
      const serve = findHelper("serve");
      assert.ok(serve, "a linux machine should resolve a helper");
      assert.equal(serve!.command, process.execPath);
      assert.ok(serve!.args[0].endsWith("privateer-computer.mjs"));
      assert.deepEqual(serve!.args.slice(1), ["--serve"]);
      assert.deepEqual(findHelper("grants")!.args.slice(1), ["--grants"]);
    });
  });
});

test("an override is honoured, and its shape is read from the extension", () => {
  const ps1 = join(REPO_ROOT, "native/win/PrivateerComputer.ps1");
  const mjs = join(REPO_ROOT, "native/linux/privateer-computer.mjs");

  // A .ps1 override on ANY platform still goes through PowerShell — the extension
  // decides how to run it, not the host platform.
  withEnv(HELPER_PATH_ENV, ps1, () => {
    assert.equal(findHelper("serve")!.command, "powershell.exe");
  });
  withEnv(HELPER_PATH_ENV, mjs, () => {
    assert.equal(findHelper("serve")!.command, process.execPath);
  });
  // Anything else is treated as a binary and invoked directly.
  withEnv(HELPER_PATH_ENV, join(REPO_ROOT, "package.json"), () => {
    const h = findHelper("serve")!;
    assert.ok(h.command.endsWith("package.json"));
    assert.deepEqual(h.args, ["--serve"]);
  });
  // An override pointing at nothing resolves to nothing rather than falling back to a
  // search: a shell that named a helper meant that one, and quietly using a different
  // binary is how a session ends up talking to something without the OS grants.
  withEnv(HELPER_PATH_ENV, join(REPO_ROOT, "no/such/helper"), () => {
    assert.equal(findHelper("serve"), undefined);
  });
});

// ─── The approval preview ────────────────────────────────────────────────────
//
// The gate is the entire safety mechanism for screen control, and a gate nobody can
// evaluate is worth nothing — "click at 812,344" is a dialog people learn to tap
// through. So the frame the model saw travels with the request. These pin the parts
// that would fail SILENTLY: a preview attached to the wrong display, a picture shown
// for an action that has no location, and the sink being asked to illustrate something
// it has never seen.

test("the sink illustrates a click with the frame its coordinates are against", async () => {
  const { ComputerPreviewSink } = await import("../src/computer/preview.ts");
  const sink = new ComputerPreviewSink();

  sink.put({ displayId: "1", data: "AAAA", width: 480, height: 300, frameWidth: 1400, frameHeight: 875 });

  const p = sink.previewFor("computer_control", { action: "click", x: 700, y: 400, display: "1" })!;
  assert.ok(p, "a click on a captured display should illustrate");
  assert.equal(p.action, "click");
  assert.deepEqual(p.target, { x: 700, y: 400 });
  // The frame's OWN dimensions ride along, because the renderer places the marker as a
  // fraction of them — without these it would have to guess, and be wrong at every
  // dialog size but one.
  assert.equal(p.image?.frameWidth, 1400);
  assert.equal(p.image?.frameHeight, 875);
  assert.equal(p.image?.data, "AAAA");
});

test("a second display's action is illustrated with ITS frame, never the other's", async () => {
  const { ComputerPreviewSink } = await import("../src/computer/preview.ts");
  const sink = new ComputerPreviewSink();
  sink.put({ displayId: "1", data: "ONE", width: 480, height: 300, frameWidth: 1400, frameHeight: 875 });
  sink.put({ displayId: "2", data: "TWO", width: 480, height: 270, frameWidth: 1400, frameHeight: 787 });

  // Naming a display must win over recency. Showing the wrong screen's picture is worse
  // than showing none: it looks like it worked, and the human approves a click they
  // believe they have seen.
  assert.equal(sink.previewFor("computer_control", { action: "click", x: 1, y: 1, display: "1" })!.image?.data, "ONE");
  assert.equal(sink.previewFor("computer_control", { action: "click", x: 1, y: 1, display: "2" })!.image?.data, "TWO");
  // With no display named, the most recently captured one is used — the same rule the
  // tool itself follows, so the picture always matches the frame the coordinates are in.
  assert.equal(sink.previewFor("computer_control", { action: "click", x: 1, y: 1 })!.image?.data, "TWO");
});

test("actions with no location get no picture", async () => {
  const { ComputerPreviewSink } = await import("../src/computer/preview.ts");
  const sink = new ComputerPreviewSink();
  sink.put({ displayId: "1", data: "ONE", width: 480, height: 300, frameWidth: 1400, frameHeight: 875 });

  // A screenshot with no marker invites the reader to hunt for one. `type` and `key`
  // already carry the whole decision in their detail line — the literal text, verbatim.
  for (const action of ["type", "key", "wait"]) {
    assert.equal(sink.previewFor("computer_control", { action, text: "x", keys: "cmd+s", ms: 5 }), undefined, action);
  }
  // And nothing else in the app ever carries an image on a permission prompt.
  assert.equal(sink.previewFor("screen_capture", { display: "1" }), undefined);
  assert.equal(sink.previewFor("bash", { command: "ls" }), undefined);
});

test("a drag carries both ends", async () => {
  const { ComputerPreviewSink } = await import("../src/computer/preview.ts");
  const sink = new ComputerPreviewSink();
  sink.put({ displayId: "1", data: "ONE", width: 480, height: 300, frameWidth: 1400, frameHeight: 875 });
  const p = sink.previewFor("computer_control", { action: "drag", x: 10, y: 20, to_x: 300, to_y: 400 })!;
  assert.deepEqual(p.target, { x: 10, y: 20 });
  assert.deepEqual(p.to, { x: 300, y: 400 });
  // `to` belongs to a drag alone — a click that happened to carry to_x must not sprout
  // a phantom second marker.
  const click = sink.previewFor("computer_control", { action: "click", x: 10, y: 20, to_x: 300, to_y: 400 })!;
  assert.equal(click.to, undefined);
});

test("nothing captured yet degrades to the text-only prompt", async () => {
  const { ComputerPreviewSink } = await import("../src/computer/preview.ts");
  const sink = new ComputerPreviewSink();
  // No frame AND no coordinates: nothing to say.
  assert.equal(sink.previewFor("computer_control", { action: "click" }), undefined);
  // Coordinates but no frame still illustrates nothing visually, and must not pretend
  // otherwise — but it is harmless to send, and a renderer draws only what it can place.
  const p = sink.previewFor("computer_control", { action: "click", x: 5, y: 6 });
  assert.equal(p?.image, undefined);
  assert.deepEqual(p?.target, { x: 5, y: 6 });

  // Cleared on dispose, so a session that ends cannot illustrate the next one.
  sink.put({ displayId: "1", data: "ONE", width: 480, height: 300, frameWidth: 1400, frameHeight: 875 });
  sink.clear();
  assert.equal(sink.previewFor("computer_control", { action: "click", x: 1, y: 1 })?.image, undefined);
});

test("the preview is small — a dialog copy, not the model's frame", async () => {
  const { planCapture, planPreview, PREVIEW_MAX_EDGE, DEFAULT_MAX_EDGE } = await import("../src/computer/space.ts");
  for (const d of DISPLAYS) {
    const plan = planCapture(d, DEFAULT_MAX_EDGE);
    const preview = planPreview(plan);
    assert.ok(Math.max(preview.width, preview.height) <= PREVIEW_MAX_EDGE, `${d.label} preview too large`);
    // Aspect preserved, or the marker's fractional placement lands off the mark.
    const a1 = plan.width / plan.height;
    const a2 = preview.width / preview.height;
    assert.ok(Math.abs(a1 - a2) < 0.02, `${d.label}: aspect drifted ${a1} → ${a2}`);
  }
});
