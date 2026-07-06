import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/components/App.tsx";
import { TodoPanel } from "../src/components/TodoPanel.tsx";
import { EntryView, groupRows, visualRows, clampStreamingText } from "../src/components/Transcript.tsx";
import { ToolCallView } from "../src/components/ToolCallView.tsx";
import { AgentGroupView } from "../src/components/AgentGroupView.tsx";
import type { Entry, ToolEntry } from "../src/components/types.ts";
import { StatusBar } from "../src/components/StatusBar.tsx";
import { ModelPicker } from "../src/components/ModelPicker.tsx";
import { PROVIDER_LIST } from "../src/providers/catalog.ts";
import { emptyUsage } from "../src/engine/events.ts";
import { Config } from "../src/config/schema.ts";
import { privateerChannel } from "../src/providers/resolve.ts";

// The model picker (and parts of the App) read the global data dir for Privateer
// account credentials. Pin PRIVATEER_HOME to an empty temp dir so the suite renders
// the signed-out state regardless of whether the machine running it is logged in.
process.env.PRIVATEER_HOME = mkdtempSync(join(tmpdir(), "privateer-tui-home-"));

// Smoke test: the App renders its full component tree (banner, status bar, input)
// without crashing when a provider is configured. No network — session construction
// is local. Verifies the Ink layout/props are wired correctly.
test("App renders banner, status bar, and prompt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "privateer-tui-"));
  try {
    const config = Config.parse({ providers: { anthropic: { apiKey: "x" } } });
    const { lastFrame, unmount } = render(
      React.createElement(App, { model: "anthropic:claude-opus-4-8", config, cwd }),
    );
    // Let effects (session build) flush.
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? "";
    assert.match(frame, /PRIVATEER/); // banner title
    assert.match(frame, /anthropic:claude-opus-4-8/);
    assert.match(frame, /privateer/); // status bar chip
    assert.match(frame, /type a prompt/); // input placeholder
    unmount();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// /fork branches a resumed conversation into a new session: a fresh id whose file
// carries a parent pointer at the source session, with latest.json following the
// branch. Drives the real input path (slash menu → command dispatch → persist).
test("/fork branches the session and records lineage", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "privateer-fork-"));
  try {
    const { saveSession, loadSession, listSessions, loadLatest } = await import("../src/memory/store.ts");
    const config = Config.parse({ providers: { anthropic: { apiKey: "x" } } });
    const resume = {
      id: "s-100",
      updatedAt: new Date().toISOString(),
      modelSpec: "anthropic:claude-opus-4-8",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ] as any,
      usage: emptyUsage(),
    };
    saveSession(cwd, resume.id, resume);
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { model: "anthropic:claude-opus-4-8", config, cwd, resume }),
    );
    await new Promise((r) => setTimeout(r, 50)); // session build + stdin attach
    stdin.write("/fork");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r"); // accept the slash-menu candidate → "/fork "
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r"); // submit
    await new Promise((r) => setTimeout(r, 50));
    assert.match(lastFrame() ?? "", /Forked into a new session branch/);

    // A second session file now exists, pointing back at the source.
    const metas = listSessions(cwd);
    assert.equal(metas.length, 2);
    const branch = metas.find((m) => m.id !== "s-100")!;
    assert.equal(branch.parentId, "s-100");
    const branchData = loadSession(cwd, branch.id)!;
    assert.equal(branchData.messages.length, 2);
    // The source keeps its own file, and --continue now follows the branch.
    assert.ok(loadSession(cwd, "s-100"));
    assert.equal(loadLatest(cwd)!.id, branch.id);
    unmount();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Ctrl+O is the unified detail toggle: it flips both reasoning collapse and
// verbose tool output. We can't easily drive a turn here, but the footer hint
// reflects the state, so a label flip proves the keybinding fires and toggles.
test("Ctrl+O toggles the transcript detail level", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "privateer-ctrlo-"));
  try {
    const config = Config.parse({ providers: { anthropic: { apiKey: "x" } } });
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { model: "anthropic:claude-opus-4-8", config, cwd }),
    );
    await new Promise((r) => setTimeout(r, 50));
    // Default resting state is collapsed → footer offers to expand.
    assert.match(lastFrame() ?? "", /Ctrl\+O expand/);
    stdin.write("\x0f"); // Ctrl+O
    await new Promise((r) => setTimeout(r, 50));
    assert.match(lastFrame() ?? "", /Ctrl\+O collapse/);
    stdin.write("\x0f"); // Ctrl+O again → back to collapsed
    await new Promise((r) => setTimeout(r, 50));
    assert.match(lastFrame() ?? "", /Ctrl\+O expand/);
    unmount();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("EntryView renders a thinking block", () => {
  const { lastFrame, unmount } = render(
    React.createElement(EntryView, { entry: { kind: "thinking", text: "weighing two approaches" } }),
  );
  assert.match(lastFrame() ?? "", /weighing two approaches/);
  unmount();
});

test("EntryView renders assistant markdown: heading, list, code, inline", () => {
  const md = [
    "# Plan",
    "",
    "Here is some `inline code` and **bold** text.",
    "",
    "- first item",
    "- second item",
    "",
    "```",
    "const x = 1;",
    "```",
  ].join("\n");
  const { lastFrame, unmount } = render(
    React.createElement(EntryView, { entry: { kind: "assistant", text: md } }),
  );
  const frame = lastFrame() ?? "";
  // Heading text survives, markers are stripped, list bullets and code are present.
  assert.match(frame, /Plan/);
  assert.doesNotMatch(frame, /# Plan/); // ATX marker consumed
  assert.match(frame, /inline code/);
  assert.doesNotMatch(frame, /`inline code`/); // backticks consumed
  assert.match(frame, /•/); // unordered list bullet
  assert.match(frame, /first item/);
  assert.match(frame, /const x = 1;/);
  unmount();
});

test("ToolCallView truncates output unless verbose", () => {
  const entry = {
    kind: "tool" as const,
    id: "1",
    name: "bash",
    input: { command: "x" },
    status: "done" as const,
    output: Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n"),
  };
  const t = render(React.createElement(ToolCallView, { entry }));
  assert.match(t.lastFrame() ?? "", /more lines/);
  t.unmount();

  const v = render(React.createElement(ToolCallView, { entry, verbose: true }));
  assert.doesNotMatch(v.lastFrame() ?? "", /more lines/);
  assert.match(v.lastFrame() ?? "", /line9/);
  v.unmount();
});

test("StatusBar renders a custom status line when provided", () => {
  const def = render(
    React.createElement(StatusBar, { modelSpec: "m", cwd: "/x", usage: emptyUsage() }),
  );
  assert.match(def.lastFrame() ?? "", /privateer/);
  def.unmount();

  const custom = render(
    React.createElement(StatusBar, {
      modelSpec: "m",
      cwd: "/x",
      usage: emptyUsage(),
      custom: "MY-STATUS-LINE",
    }),
  );
  assert.match(custom.lastFrame() ?? "", /MY-STATUS-LINE/);
  assert.doesNotMatch(custom.lastFrame() ?? "", /privateer/);
  custom.unmount();
});

// Privateer surfaces a privacy channel for every model: NEAR `near/*` ids run in a
// TEE, everything else routes through the account's ZDR proxy. The status bar must
// always show one shield or the other for a Privateer model.
test("privateerChannel classifies near/* as TEE, else ZDR", () => {
  assert.equal(privateerChannel("near/deepseek-ai/DeepSeek-V4-Flash"), "tee");
  assert.equal(privateerChannel("anthropic/claude-opus-4.8"), "zdr");
});

test("StatusBar shows the TEE shield for an attested Privateer model", () => {
  const tee = render(
    React.createElement(StatusBar, {
      modelSpec: "privateer:near/deepseek-ai/DeepSeek-V4-Flash",
      cwd: "/x",
      usage: emptyUsage(),
      tee: { kind: "ready", posture: "green", attestation: {} as any },
    }),
  );
  assert.match(tee.lastFrame() ?? "", /⛉ TEE/);
  tee.unmount();
});

test("StatusBar shows the ZDR shield for a Privateer ZDR model", () => {
  const zdr = render(
    React.createElement(StatusBar, {
      modelSpec: "privateer:anthropic/claude-opus-4.8",
      cwd: "/x",
      usage: emptyUsage(),
      zdr: { kind: "ready", posture: "green" },
    }),
  );
  assert.match(zdr.lastFrame() ?? "", /⛉ ZDR/);
  zdr.unmount();
});

// Helper to build a finished `task` entry with metrics.
const taskEntry = (id: string, description: string, toolUses: number, tokens: number): ToolEntry => ({
  kind: "tool",
  id,
  name: "task",
  input: { description },
  status: "done",
  output: "summary",
  agent: { description, toolUses, tokens },
});

test("groupRows collapses 2+ consecutive task calls but leaves a lone one alone", () => {
  const lone: Entry[] = [{ kind: "user", text: "hi" }, taskEntry("a", "one", 1, 1)];
  const loneRows = groupRows(lone);
  assert.equal(loneRows.length, 2);
  assert.equal(loneRows[1].kind, "tool"); // single task not grouped

  const fanned: Entry[] = [
    { kind: "assistant", text: "kicking off" },
    taskEntry("a", "first", 42, 50000),
    taskEntry("b", "second", 25, 52400),
    { kind: "assistant", text: "done" },
  ];
  const rows = groupRows(fanned);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].kind, "agent-group");
  assert.equal(rows[1].kind === "agent-group" && rows[1].agents.length, 2);
});

test("visualRows counts wrapped rows, not just newlines", () => {
  assert.equal(visualRows("one\ntwo\nthree", 80), 3); // three short lines
  assert.equal(visualRows("", 80), 1); // empty still occupies a row
  assert.equal(visualRows("x".repeat(25), 10), 3); // 25 cols / 10 wide → 3 rows
  assert.equal(visualRows("ab\n" + "y".repeat(20), 10), 3); // 1 + 2 wrapped
});

test("clampStreamingText keeps the tail and flags hidden lines when it overflows", () => {
  const text = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  // Fits: returned unchanged.
  assert.equal(clampStreamingText(text, 50, 80), text);
  // Overflows a 5-row budget: marker + a trimmed tail that fits the budget.
  const clamped = clampStreamingText(text, 5, 80);
  assert.match(clamped, /earlier lines hidden — shown in full when complete/);
  assert.match(clamped, /line 20$/); // newest line is still the last shown
  assert.ok(!clamped.includes("line 1\n")); // oldest lines dropped
  assert.ok(visualRows(clamped, 80) <= 5); // never taller than the budget
});

test("AgentGroupView renders the N-agents header with per-agent metrics", () => {
  const agents = [taskEntry("a", "Find request construction", 42, 50000), taskEntry("b", "Find caching", 25, 52400)];
  const { lastFrame, unmount } = render(React.createElement(AgentGroupView, { agents, collapsed: true }));
  const frame = lastFrame() ?? "";
  assert.match(frame, /2 Explore agents finished/);
  assert.match(frame, /Find request construction · 42 tool uses · 50k tokens/);
  assert.match(frame, /Find caching · 25 tool uses · 52.4k tokens/);
  assert.match(frame, /ctrl\+o to expand/);
  unmount();
});

test("TodoPanel hides when empty and lists tasks when populated", () => {
  const empty = render(React.createElement(TodoPanel, { todos: [] }));
  assert.equal((empty.lastFrame() ?? "").trim(), "");
  empty.unmount();

  const full = render(
    React.createElement(TodoPanel, {
      todos: [
        { content: "Explore", status: "completed" as const },
        { content: "Implement", status: "in_progress" as const, activeForm: "Implementing" },
        { content: "Test", status: "pending" as const },
      ],
    }),
  );
  const frame = full.lastFrame() ?? "";
  assert.match(frame, /Tasks 1\/3/);
  assert.match(frame, /Implementing/); // in_progress shows activeForm
  assert.match(frame, /Test/);
  full.unmount();
});

// /model's provider stage lists every known provider — not just the configured
// ones — with the Privateer account pinned first, unconfigured rows tagged
// "⚿ no key" (the account: "→ sign in"), and a note that remote access needs
// the account. Picking an
// unconfigured provider routes into the /keys setup flow via onSetup.
test("ModelPicker lists all providers, Privateer first, and routes unconfigured picks to setup", async () => {
  const config = Config.parse({ providers: { anthropic: { apiKey: "x" } } });
  let setup: string | null = null;
  const { lastFrame, stdin, unmount } = render(
    React.createElement(ModelPicker, {
      config,
      onSelect: () => {},
      onSetup: (name: string) => {
        setup = name;
      },
      onLogin: () => {},
    }),
  );
  await new Promise((r) => setTimeout(r, 30)); // let Ink attach its stdin listener
  const frame = lastFrame() ?? "";
  for (const p of PROVIDER_LIST) {
    assert.ok(frame.includes(p.label), `missing provider row: ${p.label}`);
  }
  const lines = frame.split("\n");
  const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
  assert.ok(at("Privateer account") < at("Anthropic"), "Privateer should be listed first");
  assert.ok(!lines[at("Anthropic")].includes("no key"), "configured provider must not be tagged");
  assert.match(lines[at("OpenAI")], /⚿ no key/);
  assert.match(lines[at("Privateer account")], /→ sign in/);
  // Providers with a blanket privacy guarantee carry a ⛉ badge; the rest don't.
  assert.match(lines[at("NEAR AI")], /⛉ TEE/);
  assert.match(lines[at("Tinfoil")], /⛉ TEE/);
  assert.match(lines[at("Venice")], /⛉ ZDR/);
  assert.match(lines[at("Privateer account")], /⛉ TEE·ZDR/);
  assert.ok(!lines[at("Anthropic")].includes("⛉"), "plain provider must not carry a privacy badge");
  // OpenRouter's ZDR is per-model/account, so its badge comes with a key line
  // explaining it goes green only under /zdr enforcement.
  assert.match(lines[at("OpenRouter")], /⛉ ZDR/);
  assert.match(frame, /⛉ ZDR available per model — \/zdr to enforce/);
  assert.match(frame, /Remote access .* works only with a Privateer account/);

  // Privateer is row 0; OpenRouter (unconfigured) is row 1. Down + enter → setup.
  stdin.write("\x1B[B");
  await new Promise((r) => setTimeout(r, 20));
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(setup, "openrouter");
  unmount();
});

// Branch badge: resuming a named branch shows "⑂ name" in the status bar, and
// /rename (typed through the real input path) names the live session in place.
test("status bar shows the branch badge and /rename updates it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "privateer-badge-"));
  try {
    const { loadSession } = await import("../src/memory/store.ts");
    const config = Config.parse({ providers: { anthropic: { apiKey: "x" } } });
    const resume = {
      id: "s-200",
      updatedAt: new Date().toISOString(),
      modelSpec: "anthropic:claude-opus-4-8",
      messages: [{ role: "user", content: "hello" }] as any,
      usage: emptyUsage(),
      parent: { id: "s-100" },
    };
    const { lastFrame, stdin, unmount } = render(
      React.createElement(App, { model: "anthropic:claude-opus-4-8", config, cwd, resume }),
    );
    await new Promise((r) => setTimeout(r, 50));
    // Unnamed branch → bare marker.
    assert.match(lastFrame() ?? "", /⑂ branch/);

    stdin.write("/rename");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r"); // accept the slash-menu candidate → "/rename "
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("auth-experiment");
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("\r"); // submit
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? "";
    assert.match(frame, /Session named "auth-experiment"/);
    assert.match(frame, /⑂ auth-experiment/);
    // The name persisted to the session file.
    assert.equal(loadSession(cwd, "s-200")!.name, "auth-experiment");
    unmount();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
