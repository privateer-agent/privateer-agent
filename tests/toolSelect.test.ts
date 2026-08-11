/**
 * Per-routine connector allow-lists: the selector → registered-name translation.
 *
 * This is the test that was missing while the feature silently granted nothing.
 * Two vocabularies have to stay straight (see src/mcp/toolNames.ts):
 *   selector   "<server>__<tool>"   — what a routine stores; what the app writes
 *   registered "<serverPrefix>_<tool>" — what pi-mcp-adapter names the tool, and the
 *                                        only thing Pi's exact-match `tools:` accepts
 *
 * The `formatToolName`/`serverPrefix` cases below mirror pi-mcp-adapter's own
 * implementation (node_modules/pi-mcp-adapter/types.ts). If the adapter ever changes
 * its naming, THESE are the assertions that should fail first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { splitRoutineTools, matchesSelector } from "../src/routines/toolSelect.ts";
import {
  serverPrefix,
  formatToolName,
  resolveMcpTools,
  resolveMcpSelection,
  readMcpInventory,
  readPrefixMode,
} from "../src/mcp/toolNames.ts";

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

// ── naming (mirrors pi-mcp-adapter) ──────────────────────────────────────────

test("serverPrefix folds dashes, and 'short' drops a trailing -mcp", () => {
  assert.equal(serverPrefix("google-calendar", "server"), "google_calendar");
  assert.equal(serverPrefix("google-calendar", "short"), "google_calendar");
  assert.equal(serverPrefix("github-mcp", "server"), "github_mcp");
  assert.equal(serverPrefix("github-mcp", "short"), "github");
  assert.equal(serverPrefix("mcp", "short"), "mcp"); // empties fall back
  assert.equal(serverPrefix("github", "none"), "");
});

test("formatToolName joins with ONE underscore — the bug this whole module exists for", () => {
  assert.equal(formatToolName("create_issue", "github", "server"), "github_create_issue");
  assert.notEqual(formatToolName("create_issue", "github", "server"), "github__create_issue");
  assert.equal(formatToolName("list_events", "google-calendar", "server"), "google_calendar_list_events");
  assert.equal(formatToolName("create_issue", "github", "none"), "create_issue");
});

// ── resolution ───────────────────────────────────────────────────────────────

const INVENTORY = {
  github: ["create_issue", "list_issues", "get_file"],
  "google-calendar": ["list_events"],
};

test("an exact selector resolves to the registered name and a scoped direct-tools entry", () => {
  const r = resolveMcpTools({ selectors: ["github__create_issue"], inventory: INVENTORY, prefix: "server" });
  assert.deepEqual(r.names, ["github_create_issue"]);
  // MCP_DIRECT_TOOLS matches the ORIGINAL tool name, "server/tool".
  assert.deepEqual(r.directToolsEnv, ["github/create_issue"]);
  assert.deepEqual(r.servers, ["github"]);
  assert.deepEqual(r.coldServers, []);
});

test("a wildcard expands over the cached inventory, and grants the bare server", () => {
  const r = resolveMcpTools({ selectors: ["github__*"], inventory: INVENTORY, prefix: "server" });
  assert.deepEqual(r.names, ["github_create_issue", "github_list_issues", "github_get_file"]);
  assert.deepEqual(r.directToolsEnv, ["github"]);
});

test("a wildcard grants ONLY its own server", () => {
  const r = resolveMcpTools({ selectors: ["github__*"], inventory: INVENTORY, prefix: "server" });
  assert.equal(r.names.some((n) => n.startsWith("google_calendar")), false);
});

test("dashed server ids resolve to the folded prefix", () => {
  const r = resolveMcpTools({ selectors: ["google-calendar__*"], inventory: INVENTORY, prefix: "server" });
  assert.deepEqual(r.names, ["google_calendar_list_events"]);
  assert.deepEqual(r.directToolsEnv, ["google-calendar"]); // the env keys off the SERVER id
});

test("an exact selector resolves even when the server has no inventory — but is flagged cold", () => {
  const r = resolveMcpTools({ selectors: ["notion__search"], inventory: INVENTORY, prefix: "server" });
  assert.deepEqual(r.names, ["notion_search"]);
  assert.deepEqual(r.coldServers, ["notion"]);
});

test("a wildcard over an uncached server expands to NOTHING and says so", () => {
  const r = resolveMcpTools({ selectors: ["notion__*"], inventory: INVENTORY, prefix: "server" });
  assert.deepEqual(r.names, []);
  assert.deepEqual(r.directToolsEnv, []);
  assert.deepEqual(r.coldServers, ["notion"]);
});

test("results are deduped and non-selectors are ignored", () => {
  const r = resolveMcpTools({
    selectors: ["github__create_issue", "github__create_issue", "github__*", "read", "github__"],
    inventory: INVENTORY,
    prefix: "server",
  });
  assert.deepEqual(r.names, ["github_create_issue", "github_list_issues", "github_get_file"]);
  assert.deepEqual(r.servers, ["github"]);
});

test("prefix mode 'none' drops the server prefix entirely", () => {
  const r = resolveMcpTools({ selectors: ["github__create_issue"], inventory: INVENTORY, prefix: "none" });
  assert.deepEqual(r.names, ["create_issue"]);
});

test("no selectors → nothing granted, nothing enabled", () => {
  const r = resolveMcpTools({ selectors: [], inventory: INVENTORY, prefix: "server" });
  assert.deepEqual(r, { names: [], servers: [], directToolsEnv: [], coldServers: [], unknownTools: [] });
});

test("a tool the connector doesn't expose is granted but reported, not silently thinned", () => {
  const r = resolveMcpTools({ selectors: ["github__delete_repo"], inventory: INVENTORY, prefix: "server" });
  assert.deepEqual(r.names, ["github_delete_repo"]); // harmless: it simply never registers
  assert.deepEqual(r.unknownTools, ["github__delete_repo"]);
  assert.deepEqual(r.coldServers, [], "the SERVER answered — only the tool is wrong");
});

test("a cold server is reported as cold, not as an unknown tool", () => {
  const r = resolveMcpTools({ selectors: ["notion__search"], inventory: INVENTORY, prefix: "server" });
  assert.deepEqual(r.coldServers, ["notion"]);
  assert.deepEqual(r.unknownTools, []);
});

// ── disk shapes ──────────────────────────────────────────────────────────────

test("reads the adapter's on-disk cache and pinned prefix, start to finish", () => {
  const dir = mkdtempSync(join(tmpdir(), "privateer-mcp-"));
  try {
    writeFileSync(
      join(dir, "mcp-cache.json"),
      JSON.stringify({
        version: 1,
        servers: {
          github: {
            configHash: "abc",
            tools: [{ name: "create_issue" }, { name: "list_issues" }],
            resources: [],
            cachedAt: 1,
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { github: { url: "https://example.test" } }, settings: { toolPrefix: "server" } }),
    );

    assert.deepEqual(readMcpInventory(dir), { github: ["create_issue", "list_issues"] });
    assert.equal(readPrefixMode(dir), "server");

    const r = resolveMcpSelection(["github__*"], dir);
    assert.deepEqual(r.names, ["github_create_issue", "github_list_issues"]);
    assert.deepEqual(r.coldServers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing cache means every selected server is cold, never a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "privateer-mcp-"));
  try {
    assert.deepEqual(readMcpInventory(dir), {});
    assert.equal(readPrefixMode(dir), "server"); // the adapter's own default
    const r = resolveMcpSelection(["github__*"], dir);
    assert.deepEqual(r.names, []);
    assert.deepEqual(r.coldServers, ["github"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed cache is treated as empty, not fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "privateer-mcp-"));
  try {
    writeFileSync(join(dir, "mcp-cache.json"), "{ not json");
    writeFileSync(join(dir, "mcp.json"), "{ not json");
    assert.deepEqual(readMcpInventory(dir), {});
    assert.equal(readPrefixMode(dir), "server");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
