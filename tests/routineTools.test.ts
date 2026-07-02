import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolSet } from "ai";
import { splitRoutineTools, matchesSelector, filterMcpTools } from "../src/routines/toolSelect.ts";
import { Routine } from "../src/routines/schema.ts";

test("splitRoutineTools: separates builtin names from MCP selectors", () => {
  const split = splitRoutineTools(["read", "sheets__get_rows", "whatsapp__send_template", "glob"]);
  assert.deepEqual(split.builtin, ["read", "glob"]);
  assert.deepEqual(split.mcp, ["sheets__get_rows", "whatsapp__send_template"]);
  assert.deepEqual(split.servers, ["sheets", "whatsapp"]);
});

test("splitRoutineTools: only selectors → empty builtin (caller falls back to safe set)", () => {
  const split = splitRoutineTools(["sheets__*"]);
  assert.deepEqual(split.builtin, []);
  assert.deepEqual(split.mcp, ["sheets__*"]);
  assert.deepEqual(split.servers, ["sheets"]);
});

test("splitRoutineTools: undefined and empty input", () => {
  assert.deepEqual(splitRoutineTools(undefined), { builtin: [], mcp: [], servers: [] });
  assert.deepEqual(splitRoutineTools([]), { builtin: [], mcp: [], servers: [] });
});

test("splitRoutineTools: dedupes server prefixes", () => {
  const split = splitRoutineTools(["sheets__get_rows", "sheets__update_cell"]);
  assert.deepEqual(split.servers, ["sheets"]);
});

test("matchesSelector: exact and per-server wildcard", () => {
  assert.ok(matchesSelector("sheets__get_rows", "sheets__get_rows"));
  assert.ok(matchesSelector("sheets__get_rows", "sheets__*"));
  assert.ok(!matchesSelector("sheets__get_rows", "sheets__update_cell"));
  assert.ok(!matchesSelector("whatsapp__send_text", "sheets__*"));
  // Wildcard is per-server, not a general prefix: "sheets2" must not match "sheets__*".
  assert.ok(!matchesSelector("sheets2__get_rows", "sheets__*"));
});

test("filterMcpTools: keeps only selected tools", () => {
  const fake = (name: string) => ({ description: name }) as ToolSet[string];
  const tools: ToolSet = {
    sheets__get_rows: fake("sheets__get_rows"),
    sheets__update_cell: fake("sheets__update_cell"),
    whatsapp__send_template: fake("whatsapp__send_template"),
    whatsapp__send_text: fake("whatsapp__send_text"),
  };
  const picked = filterMcpTools(tools, ["sheets__*", "whatsapp__send_template"]);
  assert.deepEqual(Object.keys(picked).sort(), [
    "sheets__get_rows",
    "sheets__update_cell",
    "whatsapp__send_template",
  ]);
  assert.deepEqual(filterMcpTools(tools, []), {});
});

test("schema: Routine round-trips a tools list with MCP selectors", () => {
  const r = Routine.parse({
    id: "r-1",
    name: "welcome",
    cron: "*/5 * * * *",
    prompt: "p",
    cwd: "/tmp",
    tools: ["sheets__*", "read", "whatsapp__send_template"],
  });
  assert.deepEqual(r.tools, ["sheets__*", "read", "whatsapp__send_template"]);
});
