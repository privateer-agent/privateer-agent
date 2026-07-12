import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyToolCall, isOutsideScope } from "../src/permissions/classify.ts";

// The NEW glue for the Pi rewrite: map a Pi tool_call { toolName, input } to a
// PermissionRequest (or null when no gate is needed). Pure — no live session.

const CWD = "/work/proj";
const scope = { cwd: CWD };

test("bash → bash-kind with the command as detail", () => {
  const r = classifyToolCall("bash", { command: "rm -rf /" }, scope);
  assert.equal(r?.kind, "bash");
  assert.equal(r?.detail, "rm -rf /");
});

test("write inside cwd → write-kind, not outside, not protected", () => {
  const r = classifyToolCall("write", { path: "src/a.ts", content: "x" }, scope);
  assert.equal(r?.kind, "write");
  assert.equal(r?.outside, false);
  assert.equal(r?.protected, false);
  assert.equal(r?.path, "/work/proj/src/a.ts");
});

test("write to a protected file → protected flag set", () => {
  const r = classifyToolCall("write", { path: ".env" }, scope);
  assert.equal(r?.protected, true);
});

test("edit outside cwd → outside flag + absolute path detail", () => {
  const r = classifyToolCall("edit", { file_path: "/elsewhere/a.ts" }, scope);
  assert.equal(r?.kind, "edit");
  assert.equal(r?.outside, true);
  assert.equal(r?.path, "/elsewhere/a.ts");
  assert.equal(r?.detail, "/elsewhere/a.ts");
});

test("read inside scope → null (no gate)", () => {
  assert.equal(classifyToolCall("read", { path: "src/a.ts" }, scope), null);
});

test("read outside scope → read-kind outside request", () => {
  const r = classifyToolCall("read", { path: "/etc/hosts" }, scope);
  assert.equal(r?.kind, "read");
  assert.equal(r?.outside, true);
});

test("grep with no path → null (in-cwd, no gate)", () => {
  assert.equal(classifyToolCall("grep", { pattern: "TODO" }, scope), null);
});

test("web fetch → fetch-kind with url detail", () => {
  const r = classifyToolCall("web_fetch", { url: "https://x.dev" }, scope);
  assert.equal(r?.kind, "fetch");
  assert.equal(r?.detail, "https://x.dev");
});

test("known meta tool (todo) → null", () => {
  assert.equal(classifyToolCall("todowrite", { items: [] }, scope), null);
});

test("unknown/custom tool → safe-by-default bash-kind ask", () => {
  const r = classifyToolCall("some_mcp_tool", { foo: 1 }, scope);
  assert.equal(r?.kind, "bash"); // asks in default, denies in plan
  assert.equal(r?.tool, "some_mcp_tool");
});

test("allowedOutsideRoots suppress the outside flag", () => {
  const s = { cwd: CWD, allowedOutsideRoots: ["/elsewhere"] };
  assert.equal(isOutsideScope(s, "/elsewhere/a.ts"), false);
  const r = classifyToolCall("edit", { path: "/elsewhere/a.ts" }, s);
  assert.equal(r?.outside, false);
});

test("create_routine → write-kind, trigger detail, email/webhook forces alwaysAsk", () => {
  const r = classifyToolCall("create_routine", { name: "brief", cron: "0 8 * * *", delivery: ["file"] }, scope);
  assert.equal(r?.kind, "write");
  assert.match(r!.title, /Create routine/);
  assert.match(r!.detail, /brief.*cron 0 8/);
  assert.ok(!r?.alwaysAsk); // file delivery → no off-machine egress
  const email = classifyToolCall("create_routine", { name: "y", at: "2026-01-01T00:00:00", delivery: ["email"] }, scope);
  assert.equal(email?.alwaysAsk, true); // email egress must reach the human, above bypass
  const hook = classifyToolCall("create_routine", { name: "z", cron: "* * * * *", delivery: ["webhook:slack"] }, scope);
  assert.equal(hook?.alwaysAsk, true);
});

test("confineToCwd:false disables outside gating", () => {
  const s = { cwd: CWD, confineToCwd: false };
  assert.equal(isOutsideScope(s, "/anywhere/a.ts"), false);
});

test("P5-1: a symlink inside cwd pointing outside is flagged outside (no lexical escape)", () => {
  const base = mkdtempSync(join(tmpdir(), "priv-classify-"));
  try {
    const cwd = join(base, "proj");
    const secrets = join(base, "secrets");
    mkdirSync(cwd);
    mkdirSync(secrets);
    writeFileSync(join(secrets, "id_rsa"), "KEY");
    symlinkSync(secrets, join(cwd, "link")); // cwd/link -> ../secrets (outside cwd)
    const scope = { cwd };
    // Lexically cwd/link/id_rsa looks inside cwd; symlink-canonicalization must see it's
    // really under ../secrets and flag it outside.
    assert.equal(isOutsideScope(scope, join(cwd, "link", "id_rsa")), true);
    // A genuine in-cwd file still resolves inside.
    writeFileSync(join(cwd, "a.ts"), "x");
    assert.equal(isOutsideScope(scope, join(cwd, "a.ts")), false);
    // A read through the symlink is now gated (outside), not treated as free in-cwd.
    const r = classifyToolCall("read", { path: join(cwd, "link", "id_rsa") }, scope);
    assert.equal(r?.kind, "read");
    assert.equal(r?.outside, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("P5-4: write/edit with no extractable target path → fail-safe outside (prompts)", () => {
  // Aliased param the classifier doesn't recognize as a path → can't prove in-cwd.
  const w = classifyToolCall("write", { target: "/etc/passwd", content: "x" }, scope);
  assert.equal(w?.kind, "write");
  assert.equal(w?.outside, true);
  // A patch tool whose target paths live in the diff body, not a param.
  const e = classifyToolCall("apply_patch", { patch: "*** Update File: /etc/hosts\n+evil" }, scope);
  assert.equal(e?.kind, "edit");
  assert.equal(e?.outside, true);
  // Sanity: a normal write with a real path param is unaffected (stays in-cwd).
  const ok = classifyToolCall("write", { path: "src/a.ts", content: "x" }, scope);
  assert.equal(ok?.outside, false);
});
