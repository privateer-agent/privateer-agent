import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, configLayers } from "../src/config/load.ts";

// Run `fn` with an isolated global dir (PRIVATEER_HOME) and a temp project cwd,
// restoring both afterward. Provider env vars are cleared so applyEnv() doesn't
// leak the developer's real keys into assertions.
function withScopes(fn: (g: string, p: string) => void): void {
  const g = mkdtempSync(join(tmpdir(), "priv-global-"));
  const p = mkdtempSync(join(tmpdir(), "priv-proj-"));
  const prevHome = process.env.PRIVATEER_HOME;
  const prevCwd = process.cwd();
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OLLAMA_BASE_URL"]) {
    prevEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.PRIVATEER_HOME = g;
  process.chdir(p);
  try {
    fn(g, p);
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prevHome;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(g, { recursive: true, force: true });
    rmSync(p, { recursive: true, force: true });
  }
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(obj), "utf8");
}

test("defaults apply when no config files exist", () => {
  withScopes(() => {
    const cfg = loadConfig();
    assert.equal(cfg.permissionMode, "default");
    assert.equal(cfg.maxSteps, 50);
    assert.deepEqual(cfg.allowlist, []);
  });
});

test("higher-precedence layers override lower ones (scalars)", () => {
  withScopes((g, p) => {
    writeJson(join(g, "config.json"), { permissionMode: "default", maxSteps: 10 });
    // project settings beats user config
    writeJson(join(p, ".privateer", "settings.json"), { permissionMode: "acceptEdits" });
    // settings.local beats settings.json
    writeJson(join(p, ".privateer", "settings.local.json"), { maxSteps: 99 });
    const cfg = loadConfig();
    assert.equal(cfg.permissionMode, "acceptEdits");
    assert.equal(cfg.maxSteps, 99);
  });
});

test("provider objects deep-merge across layers", () => {
  withScopes((g, p) => {
    writeJson(join(g, "config.json"), { providers: { anthropic: { apiKey: "user-key" } } });
    writeJson(join(p, ".privateer", "settings.json"), {
      providers: { openai: { apiKey: "proj-key" } },
    });
    const cfg = loadConfig();
    assert.equal(cfg.providers.anthropic?.apiKey, "user-key");
    assert.equal(cfg.providers.openai?.apiKey, "proj-key");
  });
});

test("unknown settings keys are preserved (catchall) for forward-compat", () => {
  withScopes((g) => {
    writeJson(join(g, "settings.json"), { hooks: { PreToolUse: [{ matcher: "bash" }] } });
    const cfg = loadConfig() as any;
    assert.ok(cfg.hooks?.PreToolUse, "hooks section should survive parsing");
  });
});

test("configLayers reports presence per layer", () => {
  withScopes((g, p) => {
    writeJson(join(g, "config.json"), { maxSteps: 7 });
    writeJson(join(p, ".privateer", "settings.local.json"), { maxSteps: 8 });
    const layers = configLayers();
    const byLabel = Object.fromEntries(layers.map((l) => [l.label, l.present]));
    assert.equal(byLabel["user config"], true);
    assert.equal(byLabel["project settings (local)"], true);
    assert.equal(byLabel["user settings"], false);
    // ordered low → high so later wins
    assert.ok(
      layers.findIndex((l) => l.label === "user config") <
        layers.findIndex((l) => l.label === "project settings (local)"),
    );
  });
});
