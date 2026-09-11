import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import privateerModels from "../extensions/privateer-models.ts";
import { agentDir } from "../src/config/paths.ts";
import { savedPiDefaultSpec, resolveDefaultModel } from "../src/providers/defaultModel.ts";

const HOMES: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "priv-models-test-"));
  HOMES.push(home);
  process.env.PRIVATEER_HOME = home;
  mkdirSync(agentDir(), { recursive: true });
  return home;
}

test.after(() => {
  for (const home of HOMES) {
    rmSync(home, { recursive: true, force: true });
  }
});

test("models command: registers with expected description and argumentHint", () => {
  freshHome();
  let registeredName = "";
  let registeredOpts: any;
  privateerModels({
    registerCommand: (name: string, opts: any) => {
      registeredName = name;
      registeredOpts = opts;
    },
  });

  assert.equal(registeredName, "models");
  assert.equal(registeredOpts?.argumentHint, "[search]");
  assert.equal(typeof registeredOpts?.handler, "function");
});

test("models command: interactive selection persists to settings.json", async () => {
  freshHome();
  let handler!: (args: string, ctx: any) => Promise<void>;
  let modelSet: any = null;

  privateerModels({
    registerCommand: (_name: string, opts: any) => {
      handler = opts.handler;
    },
    setModel: async (model: any) => {
      modelSet = model;
      return true;
    },
  });

  const available = [
    { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
  ];

  const notices: Array<{ text: string; level: string }> = [];
  const ctx = {
    ui: {
      custom: async (factory: any) => {
        // Mock TuiLike and ThemeLike, and call close with the selected row
        let selectedRow: any = null;
        const fakeTui = { requestRender: () => {} };
        const fakeTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
        const picker = factory(fakeTui, fakeTheme, null, (res: any) => {
          selectedRow = res;
        });
        // Select the first row via confirmation
        picker.handleInput("\r");
        return selectedRow;
      },
      notify: (text: string, level: string) => {
        notices.push({ text, level });
      },
    },
    modelRegistry: {
      refresh: () => {},
      getAvailable: async () => available,
    },
    model: available[0],
  };

  await handler("", ctx);

  assert.ok(modelSet, "setModel must be called");
  assert.equal(modelSet.provider, "anthropic");
  assert.equal(modelSet.id, "claude-opus-4-8");

  // Verify settings.json was written
  const settingsPath = join(agentDir(), "settings.json");
  assert.ok(existsSync(settingsPath), "settings.json must exist");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.defaultProvider, "anthropic");
  assert.equal(settings.defaultModel, "claude-opus-4-8");

  // Verify savedPiDefaultSpec and resolveDefaultModel pick it up
  assert.equal(savedPiDefaultSpec(), "anthropic/claude-opus-4-8");
  assert.equal(resolveDefaultModel({ env: {}, signedIn: true }), "anthropic/claude-opus-4-8");

  // Verify info notice was emitted
  assert.ok(notices.some((n) => n.level === "info" && n.text.includes("anthropic/claude-opus-4-8")));
});

test("models command: headless exact match switches and persists to settings.json", async () => {
  freshHome();
  let handler!: (args: string, ctx: any) => Promise<void>;
  let modelSet: any = null;

  privateerModels({
    registerCommand: (_name: string, opts: any) => {
      handler = opts.handler;
    },
    setModel: async (model: any) => {
      modelSet = model;
      return true;
    },
  });

  const available = [
    { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
  ];

  const notices: Array<{ text: string; level: string }> = [];
  const ctx = {
    ui: {
      // Non-interactive / no custom TUI
      notify: (text: string, level: string) => {
        notices.push({ text, level });
      },
    },
    modelRegistry: {
      refresh: () => {},
      getAvailable: async () => available,
    },
    model: available[0],
  };

  await handler("openai/gpt-5.5", ctx);

  assert.ok(modelSet, "setModel must be called");
  assert.equal(modelSet.provider, "openai");
  assert.equal(modelSet.id, "gpt-5.5");

  // Verify settings.json was written
  const settings = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, "openai");
  assert.equal(settings.defaultModel, "gpt-5.5");

  assert.equal(savedPiDefaultSpec(), "openai/gpt-5.5");
  assert.equal(resolveDefaultModel({ env: {}, signedIn: true }), "openai/gpt-5.5");
});

test("models command: rejected setModel does not persist", async () => {
  freshHome();
  let handler!: (args: string, ctx: any) => Promise<void>;

  privateerModels({
    registerCommand: (_name: string, opts: any) => {
      handler = opts.handler;
    },
    setModel: async (_model: any) => {
      return false; // Auth check failed
    },
  });

  const available = [
    { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
  ];

  const notices: Array<{ text: string; level: string }> = [];
  const ctx = {
    ui: {
      notify: (text: string, level: string) => {
        notices.push({ text, level });
      },
    },
    modelRegistry: {
      refresh: () => {},
      getAvailable: async () => available,
    },
    model: available[0],
  };

  await handler("anthropic/claude-opus-4-8", ctx);

  const settingsPath = join(agentDir(), "settings.json");
  assert.ok(!existsSync(settingsPath), "settings.json must not be created on auth failure");
  assert.ok(notices.some((n) => n.level === "warning" && n.text.includes("No API key")));
});
