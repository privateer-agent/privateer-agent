/**
 * The edges of moving from pi-mcp-adapter to Pi's built-in MCP support and codemode.
 *
 * Each test here pins one place where the switch changed what reaches the model, the
 * app, or the disk — the parts no single module's own suite would notice going wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { makePermissionGate, redactJson } from "../src/ext/permissionGate.ts";
import { isProtectedPath } from "../src/permissions/protected.ts";
import { PRIVATE_TOOLS } from "../src/permissions/privateMode.ts";
import { createEngineEventAdapter } from "../src/bridge/engineAdapter.ts";
import { MCP_CATALOG } from "../src/mcp/catalog.ts";
// @ts-expect-error — plain-JS wrapper with no .d.ts; the exports are pure functions.
import { buildChildArgs } from "../bin/privateer-subagent.mjs";

// ── redaction reaches what codemode scripts read ─────────────────────────────

const redact = (s: string) => s.replace(/sk_live_\w+/g, "[redacted]");

test("redactJson redacts every string, and returns the same value when nothing matched", () => {
  const clean = { a: ["x", { b: 1 }], c: null };
  assert.equal(redactJson(clean, redact), clean);
  assert.deepEqual(redactJson({ out: "key sk_live_abc", list: ["sk_live_def"], n: 2 }, redact), {
    out: "key [redacted]",
    list: ["[redacted]"],
    n: 2,
  });
});

test("the gate's tool_result redacts structuredContent, which scripts get instead of text", () => {
  const handlers: Record<string, (e: any, ctx?: any) => any> = {};
  makePermissionGate({
    getMode: () => "default",
    setMode: () => {},
    allowlist: [],
    allowedOutsideRoots: [],
    cwd: "/tmp",
    redact,
  } as any)({ on: (ev: string, fn: any) => (handlers[ev] = fn) } as any);

  // A bash call made from a script: the model sees `content`, the script sees this.
  const out = handlers.tool_result({
    toolName: "bash",
    toolCallId: "c1/1",
    content: [{ type: "text", text: "ok" }],
    structuredContent: { output: "TOKEN=sk_live_abc\n", exit_code: 0 },
  });
  assert.deepEqual(out?.structuredContent, { output: "TOKEN=[redacted]\n", exit_code: 0 });
  // Returned alongside content: Pi drops structuredContent if only content comes back.
  assert.ok(out?.content);

  // Nothing to redact → no rewrite at all.
  assert.equal(
    handlers.tool_result({ toolName: "bash", toolCallId: "c2", content: [{ type: "text", text: "ok" }], structuredContent: { output: "fine" } }),
    undefined,
  );
});

test("in plan mode every MCP call is refused without asking, whatever it claims", async () => {
  const handlers: Record<string, (e: any, ctx?: any) => any> = {};
  const asked: string[] = [];
  makePermissionGate({
    getMode: () => "plan",
    setMode: () => {},
    allowlist: [],
    allowedOutsideRoots: [],
    cwd: "/tmp",
    localAsk: async (req: any) => {
      asked.push(req.title);
      return "deny";
    },
  } as any)({
    on: (ev: string, fn: any) => (handlers[ev] = fn),
    getAllTools: () => [
      { name: "mcp__docs__search", annotations: { readOnlyHint: true } },
      { name: "mcp__docs__delete_page", annotations: { destructiveHint: true } },
    ],
  } as any);
  const ctx = { hasUI: true, ui: {} };
  for (const toolName of ["mcp__docs__search", "mcp__docs__delete_page"]) {
    const blocked = await handlers.tool_call({ toolName, toolCallId: "1", input: {} }, ctx);
    assert.equal(blocked?.block, true, toolName);
  }
  assert.deepEqual(asked, [], "plan mode never puts an MCP call to the human");
});

// ── what an agent may write ──────────────────────────────────────────────────

test("a project's MCP config is protected — Pi runs the commands in it", () => {
  assert.equal(isProtectedPath("/repo/.pi/mcp.json"), true);
  assert.equal(isProtectedPath("/repo/.privateer/mcp.json"), true);
  assert.equal(isProtectedPath("/repo/src/mcp.json"), false, "an ordinary file of that name is not");
});

test("private mode admits none of the MCP or codemode tools", () => {
  for (const t of ["codemode", "tool_search", "mcp__github__get_file", "read_mcp_resource", "list_mcp_resources"]) {
    assert.equal(PRIVATE_TOOLS.has(t), false, t);
  }
});

// ── what the app sees ────────────────────────────────────────────────────────

test("calls a codemode script makes don't become top-level tool cards", () => {
  const a = createEngineEventAdapter();
  const nested = { toolCallId: "c1/1", parentToolCallId: "c1", toolName: "bash" };
  assert.deepEqual(a.toEngineEvents({ type: "tool_execution_start", ...nested, args: {} } as any), []);
  assert.deepEqual(a.toEngineEvents({ type: "tool_execution_update", ...nested, partialResult: {} } as any), []);
  assert.deepEqual(a.toEngineEvents({ type: "tool_execution_end", ...nested, result: {}, isError: false } as any), []);
  // The script itself still is one.
  const top = a.toEngineEvents({ type: "tool_execution_start", toolCallId: "c1", toolName: "codemode", args: {} } as any);
  assert.equal(top[0]?.type, "tool-call");
});

// ── config ───────────────────────────────────────────────────────────────────

test("the catalog has no legacy SSE endpoints — Pi speaks streamable HTTP only", () => {
  for (const e of MCP_CATALOG) {
    if (e.url) assert.doesNotMatch(new URL(e.url).pathname, /\/sse\/?$/i, e.id);
  }
});

test("a subagent child inherits its parent's built-in MCP support by name", () => {
  const gate = join(import.meta.dirname, "..", "extensions", "privateer-gate.ts");
  const env = { PRIVATEER_CHILD_EXTENSIONS: gate, PRIVATEER_CHILD_BUILTINS: "mcp,tool-search" };
  const args = buildChildArgs(["Task: x"], undefined, env);
  assert.deepEqual(args, ["--no-extensions", "-e", gate, "-e", "builtin:mcp", "-e", "builtin:tool-search", "Task: x"]);
});
