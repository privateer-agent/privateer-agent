import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/components/App.tsx";
import { TodoPanel } from "../src/components/TodoPanel.tsx";
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
