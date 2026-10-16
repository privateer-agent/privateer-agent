/**
 * src/mcp/piMcp.ts — Pi's MCP sign-in, sign-out, status and connection test, for the
 * desktop's connector manager. Those reach into pi-coding-agent internals that are not
 * in its package exports, so these tests are what notice a Pi release moving them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An isolated agent dir, set BEFORE the modules that read it are loaded.
const HOME = mkdtempSync(join(tmpdir(), "pv-pimcp-"));
process.env.PRIVATEER_HOME = HOME;
process.env.PI_CODING_AGENT_DIR = join(HOME, "agent");
const { mcpHandshake, mcpAuthStatus, mcpSignIn } = await import("../src/mcp/piMcp.ts");
const { loadWindowMcpConfig } = await import("../src/config/moat.ts");
const { makeMcpControl } = await import("../src/remote/mcpControl.ts");

const SERVER = join(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");
test.after(() => rmSync(HOME, { recursive: true, force: true }));

test("mcpHandshake connects as a session would and lists the tools", async () => {
  const r = await mcpHandshake("echo", { command: process.execPath, args: [SERVER] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.tools?.map((t) => t.name).sort(), ["echo", "shout"]);
});

test("mcpHandshake reports a server that fails to start, without hanging", async () => {
  const r = await mcpHandshake("nope", { command: join(HOME, "no-such-binary") }, 10_000);
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test("mcpAuthStatus: only an HTTP server without its own Authorization header does OAuth", async () => {
  assert.equal(await mcpAuthStatus({ name: "local" }), "not_supported");
  assert.equal(
    await mcpAuthStatus({ name: "keyed", url: "https://a.test/mcp", headers: { authorization: "Bearer x" } }),
    "not_supported",
  );
  assert.equal(await mcpAuthStatus({ name: "linear", url: "https://mcp.linear.app/mcp" }), "not_authenticated");
});

test("mcpSignIn refuses a connector that doesn't use OAuth, with Pi's reason", async () => {
  makeMcpControl().save({ name: "local", transport: "stdio", command: process.execPath, args: [SERVER] });
  const r = await mcpSignIn("local", () => assert.fail("must not open a browser"));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /does not use OAuth/);
});

test("a window's mcp.json loads as exactly its own servers", () => {
  const path = join(HOME, "window-1.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { echo: { command: "node", args: [SERVER] } } }));
  const loaded = loadWindowMcpConfig(path);
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.servers, [{ name: "echo", config: { command: "node", args: [SERVER] }, source: path, scope: "global" }]);
  const missing = loadWindowMcpConfig(join(HOME, "nope.json"));
  assert.deepEqual(missing.servers, []);
  assert.equal(missing.errors.length, 1);
});
