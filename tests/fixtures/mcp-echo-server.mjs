// A minimal MCP stdio server for tests: `echo` (declares itself read-only) and `shout`.
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") return send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } } });
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
    { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
    { name: "shout", description: "Uppercase text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  ] } });
  if (msg.method === "tools/call") { const t = msg.params.arguments?.text ?? ""; return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: msg.params.name === "shout" ? t.toUpperCase() : `echo: ${t}` }] } }); }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
});
