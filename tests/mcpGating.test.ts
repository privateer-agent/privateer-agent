import { test } from "node:test";
import assert from "node:assert/strict";

import { decideAuto } from "../src/permissions/mode.ts";
import { adaptMcpTools, type McpToolDef } from "../src/mcp/client.ts";
import type { PermissionRequest } from "../src/permissions/gate.ts";

// An MCP server can flag a tool destructive (destructiveHint). adaptMcpTools maps
// that to `alwaysAsk`, which the gate never auto-approves — so an irreversible
// external action always reaches the human, even under bypass mode.
test("adaptMcpTools marks destructive MCP tools alwaysAsk; read-only tools are normal", async () => {
  const requests: PermissionRequest[] = [];
  const gate = {
    async request(req: PermissionRequest) {
      requests.push(req);
      return "allow" as const;
    },
  };
  const fakeClient = { callTool: async () => "ok" } as any;
  const defs: McpToolDef[] = [
    { name: "send", annotations: { destructiveHint: true } },
    { name: "lookup", annotations: { readOnlyHint: true } },
    // destructive + readOnly is contradictory → treat as read-only (not alwaysAsk).
    { name: "weird", annotations: { destructiveHint: true, readOnlyHint: true } },
    { name: "plain" }, // no annotations
  ];
  const tools = adaptMcpTools("srv", fakeClient, defs, gate);

  for (const d of defs) await (tools[`srv__${d.name}`] as any).execute({}, {});

  const byTool = (t: string) => requests.find((r) => r.tool === t)!;
  assert.equal(byTool("srv__send").alwaysAsk, true, "destructive → alwaysAsk");
  assert.ok(!byTool("srv__lookup").alwaysAsk, "read-only → not alwaysAsk");
  assert.ok(!byTool("srv__weird").alwaysAsk, "destructive+readOnly → not alwaysAsk");
  assert.ok(!byTool("srv__plain").alwaysAsk, "unannotated → not alwaysAsk");
});

test("decideAuto: alwaysAsk overrides bypass; a normal fetch auto-approves under bypass", () => {
  const base = { tool: "srv__send", kind: "fetch" as const, title: "x", detail: "y" };
  assert.equal(decideAuto({ ...base, alwaysAsk: true }, "bypass", [], []), "ask");
  assert.equal(decideAuto({ ...base, alwaysAsk: false }, "bypass", [], []), "allow");
  // alwaysAsk also confirms in normal mode (a plain fetch would too, so check both).
  assert.equal(decideAuto({ ...base, alwaysAsk: true }, "default", [], []), "ask");
});
