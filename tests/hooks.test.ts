import { test } from "node:test";
import assert from "node:assert/strict";
import { HookRunner, loadHooks, wrapToolsWithHooks } from "../src/hooks/engine.ts";

test("loadHooks keeps known events with a command, drops junk", () => {
  const cfg = loadHooks({
    PreToolUse: [{ matcher: "bash", command: "x" }],
    PostToolUse: [{}], // no command → dropped
    Bogus: [{ command: "y" }], // unknown event → ignored
  });
  assert.deepEqual(cfg.PreToolUse, [{ matcher: "bash", command: "x" }]);
  assert.equal(cfg.PostToolUse, undefined);
  assert.equal((cfg as any).Bogus, undefined);
});

test("PreToolUse hook blocks a matching tool via decision JSON", async () => {
  const runner = new HookRunner(
    { PreToolUse: [{ matcher: "write", command: `echo '{"decision":"block","reason":"no writes"}'` }] },
    process.cwd(),
  );
  const blocked = await runner.tool("PreToolUse", "write", { input: {} });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason ?? "", /no writes/);
  // A non-matching tool name is unaffected.
  const ok = await runner.tool("PreToolUse", "read", { input: {} });
  assert.notEqual(ok.block, true);
});

test("wrapToolsWithHooks short-circuits a blocked tool (exit 2)", async () => {
  let ran = 0;
  const tools = {
    write: { execute: async () => ((ran++), "did write") },
  } as any;
  const runner = new HookRunner({ PreToolUse: [{ matcher: "write", command: "exit 2" }] }, process.cwd());
  const wrapped = wrapToolsWithHooks(tools, runner);
  const res = await (wrapped.write as any).execute({}, {});
  assert.match(res, /Blocked by PreToolUse/);
  assert.equal(ran, 0);
});

test("wrapToolsWithHooks runs a non-matching tool and fires PostToolUse", async () => {
  let ran = 0;
  const tools = { read: { execute: async () => ((ran++), "data") } } as any;
  const runner = new HookRunner(
    { PreToolUse: [{ matcher: "write", command: "exit 2" }], PostToolUse: [{ command: "cat >/dev/null" }] },
    process.cwd(),
  );
  const wrapped = wrapToolsWithHooks(tools, runner);
  const res = await (wrapped.read as any).execute({}, {});
  assert.equal(res, "data");
  assert.equal(ran, 1);
});

test("UserPromptSubmit hook injects additional context", async () => {
  const runner = new HookRunner(
    { UserPromptSubmit: [{ command: `echo '{"additionalContext":"remember X"}'` }] },
    process.cwd(),
  );
  const out = await runner.prompt("hello");
  assert.match(out.additionalContext ?? "", /remember X/);
});
