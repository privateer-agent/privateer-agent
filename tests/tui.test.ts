import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/components/App.tsx";
import { TodoPanel } from "../src/components/TodoPanel.tsx";
import { EntryView, groupRows } from "../src/components/Transcript.tsx";
import { ToolCallView } from "../src/components/ToolCallView.tsx";
import { AgentGroupView } from "../src/components/AgentGroupView.tsx";
import type { Entry, ToolEntry } from "../src/components/types.ts";
import { StatusBar } from "../src/components/StatusBar.tsx";
import { emptyUsage } from "../src/engine/events.ts";
import { Config } from "../src/config/schema.ts";

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
