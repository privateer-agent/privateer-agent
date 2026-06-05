import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/components/App.tsx";
import { TodoPanel } from "../src/components/TodoPanel.tsx";
import { EntryView } from "../src/components/Transcript.tsx";
import { ToolCallView } from "../src/components/ToolCallView.tsx";
import { StatusBar } from "../src/components/StatusBar.tsx";
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
    assert.match(frame, /Welcome to Privateer/);
    assert.match(frame, /anthropic:claude-opus-4-8/);
    assert.match(frame, /privateer/); // status bar chip
    assert.match(frame, /default/); // permission mode in status bar
    assert.match(frame, /type a prompt/); // input placeholder
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
    React.createElement(StatusBar, { modelSpec: "m", cwd: "/x", totalTokens: 0, mode: "default" as const }),
  );
  assert.match(def.lastFrame() ?? "", /privateer/);
  def.unmount();

  const custom = render(
    React.createElement(StatusBar, {
      modelSpec: "m",
      cwd: "/x",
      totalTokens: 0,
      mode: "default" as const,
      custom: "MY-STATUS-LINE",
    }),
  );
  assert.match(custom.lastFrame() ?? "", /MY-STATUS-LINE/);
  assert.doesNotMatch(custom.lastFrame() ?? "", /privateer/);
  custom.unmount();
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
