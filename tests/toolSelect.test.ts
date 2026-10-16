/**
 * Per-routine connector allow-lists: the selector → registered-name translation.
 *
 * Two vocabularies have to stay straight (see src/mcp/toolNames.ts):
 *   selector   "<server>__<tool>"        — what a routine stores; what the app writes
 *   registered "mcp__<server>__<tool>"   — what Pi's MCP support names the tool
 *
 * The naming cases below run against Pi's OWN createMcpToolName and its `tools:`
 * matcher, so if Pi ever changes how it names or matches MCP tools, these are the
 * assertions that fail first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { splitRoutineTools, matchesSelector } from "../src/routines/toolSelect.ts";
import { mcpToolName, resolveMcpTools, isToolOfServer } from "../src/mcp/toolNames.ts";
// Not in the package exports — Pi's own naming and allow-list matching.
import { createMcpToolName } from "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js";
import { createToolNameMatcher } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js";

// ── splitting ────────────────────────────────────────────────────────────────

test("splitRoutineTools separates builtins from MCP selectors", () => {
  const split = splitRoutineTools(["read", "github__create_issue", "grep", "linear__*"]);
  assert.deepEqual(split.builtin, ["read", "grep"]);
  assert.deepEqual(split.mcp, ["github__create_issue", "linear__*"]);
  assert.deepEqual(split.servers, ["github", "linear"]);
});

test("splitRoutineTools treats a leading __ as a builtin, not a headless selector", () => {
  // indexOf("__") === 0 is not a server; it must not produce a server named "".
  const split = splitRoutineTools(["__weird", "read"]);
  assert.deepEqual(split.mcp, []);
  assert.deepEqual(split.builtin, ["__weird", "read"]);
});

test("splitRoutineTools splits on the FIRST __, so a tool may contain one", () => {
  const split = splitRoutineTools(["srv__odd__tool"]);
  assert.deepEqual(split.servers, ["srv"]);
  assert.deepEqual(split.mcp, ["srv__odd__tool"]);
});

test("matchesSelector: exact and per-server wildcard, in the SELECTOR vocabulary", () => {
  assert.equal(matchesSelector("github__create_issue", "github__create_issue"), true);
  assert.equal(matchesSelector("github__create_issue", "github__*"), true);
  assert.equal(matchesSelector("gitlab__create_issue", "github__*"), false);
  assert.equal(matchesSelector("github__create_issue", "github__list_issues"), false);
});

// ── naming (mirrors Pi) ──────────────────────────────────────────────────────

test("mcpToolName matches Pi's own createMcpToolName", () => {
  for (const [server, tool] of [
    ["github", "create_issue"],
    ["google-calendar", "list_events"],
    ["dev.radius", "search-code"],
    ["srv", "odd__tool"],
    // Over Pi's 64-character cap: shortened with a hash, by the same rule.
    ["google-workspace-enterprise", "list_calendar_events_for_all_shared_resources"],
  ]) {
    assert.equal(mcpToolName(server, tool), createMcpToolName(server, tool), `${server}/${tool}`);
  }
  assert.equal(mcpToolName("google-calendar", "list_events"), "mcp__google_calendar__list_events");
});

// ── resolution ───────────────────────────────────────────────────────────────

test("an exact selector becomes the registered name", () => {
  const r = resolveMcpTools(["github__create_issue"]);
  assert.deepEqual(r.patterns, ["mcp__github__create_issue"]);
  assert.deepEqual(r.servers, ["github"]);
});

test("a wildcard becomes a Pi pattern that grants ONLY its own server", () => {
  const r = resolveMcpTools(["github__*"]);
  assert.deepEqual(r.patterns, ["mcp__github__*"]);
  const allowed = createToolNameMatcher(r.patterns);
  assert.equal(allowed(createMcpToolName("github", "create_issue")), true);
  assert.equal(allowed(createMcpToolName("github", "get_file")), true);
  assert.equal(allowed(createMcpToolName("gitlab", "create_issue")), false);
  // "github" must not reach a server whose name merely starts with it.
  assert.equal(allowed(createMcpToolName("github-enterprise", "create_issue")), false);
});

test("dashed server ids resolve to Pi's folded names", () => {
  const r = resolveMcpTools(["google-calendar__list_events", "google-calendar__*"]);
  assert.deepEqual(r.patterns, ["mcp__google_calendar__list_events", "mcp__google_calendar__*"]);
  assert.deepEqual(r.servers, ["google-calendar"]);
});

test("results are deduped and non-selectors are ignored", () => {
  const r = resolveMcpTools(["github__get_file", "github__get_file", "read", "__x", "github__"]);
  assert.deepEqual(r.patterns, ["mcp__github__get_file"]);
  assert.deepEqual(r.servers, ["github"]);
});

test("no selectors → nothing granted", () => {
  assert.deepEqual(resolveMcpTools([]), { patterns: [], servers: [] });
});

test("isToolOfServer tells a server's tools from a similarly-named server's", () => {
  assert.equal(isToolOfServer(createMcpToolName("github", "x"), "github"), true);
  assert.equal(isToolOfServer(createMcpToolName("github-enterprise", "x"), "github"), false);
  assert.equal(isToolOfServer(createMcpToolName("google-calendar", "x"), "google-calendar"), true);
});
