import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  McpStdioClient,
  loadMcpServers,
  connectMcpServers,
  adaptMcpTools,
} from "../src/mcp/client.ts";
import { autoApproveGate } from "../src/permissions/gate.ts";

// A tiny MCP server speaking newline-delimited JSON-RPC over stdio.
const MOCK_SERVER = `
process.stdin.setEncoding("utf8");
let buf = "";
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock", version: "1" } } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
    } else if (msg.method === "tools/call") {
      const t = (msg.params && msg.params.arguments && msg.params.arguments.text) || "";
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echoed: " + t }] } });
    }
  }
});
`;

function withMockServer(fn: (dir: string, script: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "priv-mcp-"));
  const script = join(dir, "mock-server.mjs");
  writeFileSync(script, MOCK_SERVER, "utf8");
  return fn(dir, script).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("loadMcpServers reads the mcpServers map and validates entries", () => {
  const proj = mkdtempSync(join(tmpdir(), "priv-proj-"));
  const prevHome = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = mkdtempSync(join(tmpdir(), "priv-home-"));
  try {
    mkdirSync(join(proj, ".privateer"), { recursive: true });
    writeFileSync(
      join(proj, ".privateer", "mcp.json"),
      JSON.stringify({ mcpServers: { good: { command: "node", args: ["x"] }, bad: { notcommand: 1 } } }),
      "utf8",
    );
    const servers = loadMcpServers(proj);
    assert.ok(servers.good);
    assert.equal(servers.bad, undefined); // entry without a command is dropped
  } finally {
    rmSync(process.env.PRIVATEER_HOME!, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prevHome;
    rmSync(proj, { recursive: true, force: true });
  }
});

test("McpStdioClient connects, lists tools, and calls one", async () => {
  await withMockServer(async (dir, script) => {
    const client = new McpStdioClient("mock", { command: "node", args: [script] }, dir);
    await client.connect();
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "echo");
    const out = await client.callTool("echo", { text: "hi" });
    assert.match(out, /echoed: hi/);
    client.close();
  });
});

test("connectMcpServers adapts namespaced, gated tools", async () => {
  await withMockServer(async (dir, script) => {
    const conn = await connectMcpServers({ mock: { command: "node", args: [script] } }, dir, autoApproveGate);
    assert.equal(conn.status[0].tools, 1);
    const adapted = conn.tools["mock__echo"] as any;
    assert.ok(adapted, "tool is namespaced server__tool");
    const res = await adapted.execute({ text: "x" }, {});
    assert.match(res, /echoed: x/);
    conn.clients.forEach((c) => c.close());
  });
});

test("adapted MCP tool denies when the gate denies", async () => {
  await withMockServer(async (dir, script) => {
    const client = new McpStdioClient("mock", { command: "node", args: [script] }, dir);
    await client.connect();
    const defs = await client.listTools();
    const denyGate = { request: async () => "deny" as const };
    const tools = adaptMcpTools("mock", client, defs, denyGate);
    await assert.rejects(() => (tools["mock__echo"] as any).execute({ text: "x" }, {}));
    client.close();
  });
});
