import { test } from "node:test";
import assert from "node:assert/strict";
import { runCommand, type CommandContext } from "../src/commands/registry.ts";
import { Config } from "../src/config/schema.ts";
import { emptyUsage } from "../src/engine/events.ts";

const ctx: CommandContext = {
  config: Config.parse({ providers: { anthropic: { apiKey: "x" } } }),
  modelSpec: "anthropic:claude-opus-4-8",
  mode: "default",
  usage: emptyUsage(),
  cwd: process.cwd(),
  todos: [],
};

test("non-slash input is not a command", () => {
  assert.equal(runCommand("hello world", ctx), null);
});

test("/help lists commands", () => {
  const r = runCommand("/help", ctx);
  assert.equal(r?.type, "notice");
  assert.match((r as any).text, /\/model/);
  assert.match((r as any).text, /\/provider/);
});

test("/model with no args opens the picker, with arg sets it", () => {
  assert.deepEqual(runCommand("/model", ctx), { type: "pickModel" });
  const set = runCommand("/model openrouter:foo/bar", ctx);
  assert.deepEqual(set, { type: "setModel", spec: "openrouter:foo/bar" });
});

test("/model rejects malformed spec", () => {
  const r = runCommand("/model nocolon", ctx);
  assert.equal(r?.type, "notice");
  assert.equal((r as any).tone, "error");
});

test("/provider shows readiness", () => {
  const r = runCommand("/provider", ctx);
  assert.match((r as any).text, /anthropic/);
  assert.match((r as any).text, /openrouter/);
});

test("/permissions sets a known mode and rejects unknown", () => {
  assert.deepEqual(runCommand("/permissions bypass", ctx), { type: "setMode", mode: "bypass" });
  assert.equal((runCommand("/permissions nope", ctx) as any).tone, "error");
});

test("unknown command errors", () => {
  const r = runCommand("/frobnicate", ctx);
  assert.equal((r as any).tone, "error");
});

test("/clear and /exit map to control results", () => {
  assert.deepEqual(runCommand("/clear", ctx), { type: "clear" });
  assert.deepEqual(runCommand("/exit", ctx), { type: "exit" });
});

test("/compact maps to a compact result", () => {
  assert.deepEqual(runCommand("/compact", ctx), { type: "compact" });
});

test("/init (no args) asks the agent to write PRIVATEER.md", () => {
  const r = runCommand("/init", ctx);
  assert.equal(r?.type, "runPrompt");
  assert.match((r as any).text, /PRIVATEER\.md/);
});

test("/todo reports empty and populated lists", () => {
  assert.match((runCommand("/todo", ctx) as any).text, /No tasks/);
  const withTodos = {
    ...ctx,
    todos: [{ content: "Wire auth", status: "in_progress" as const }],
  };
  assert.match((runCommand("/todo", withTodos) as any).text, /Wire auth/);
});
