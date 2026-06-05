import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { Root } from "../src/components/Root.tsx";
import { Config } from "../src/config/schema.ts";

const tick = () => new Promise((r) => setTimeout(r, 50));

test("Root shows onboarding when started in onboarding", async () => {
  const home = mkdtempSync(join(tmpdir(), "privateer-home-"));
  process.env.PRIVATEER_HOME = home;
  try {
    const config = Config.parse({});
    const { lastFrame, unmount } = render(
      React.createElement(Root, {
        config,
        modelSpec: "anthropic:claude-opus-4-8",
        cwd: process.cwd(),
        startInOnboarding: true,
      }),
    );
    await tick();
    assert.match(lastFrame() ?? "", /set up your providers/);
    unmount();
  } finally {
    delete process.env.PRIVATEER_HOME;
    rmSync(home, { recursive: true, force: true });
  }
});

test("Root shows the app when a provider is configured", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "privateer-root-"));
  try {
    const config = Config.parse({ providers: { anthropic: { apiKey: "x" } } });
    const { lastFrame, unmount } = render(
      React.createElement(Root, {
        config,
        modelSpec: "anthropic:claude-opus-4-8",
        cwd,
        startInOnboarding: false,
      }),
    );
    await tick();
    assert.match(lastFrame() ?? "", /PRIVATEER/);
    assert.match(lastFrame() ?? "", /type a prompt/);
    unmount();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
