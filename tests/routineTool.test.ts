import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routineTool } from "../src/tools/routine.ts";
import { loadRoutines } from "../src/routines/store.ts";
import type { PermissionRequest } from "../src/permissions/gate.ts";
import type { ToolContext } from "../src/tools/context.ts";

// Run `fn` with PRIVATEER_HOME pointed at a temp dir (no daemon socket there, so the
// tool falls back to writing routines.json directly) and a gate that records requests.
async function withRoutineTool(
  fn: (execute: (input: Record<string, unknown>) => Promise<unknown>, requests: PermissionRequest[]) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "priv-home-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  const requests: PermissionRequest[] = [];
  const ctx: ToolContext = {
    cwd: home,
    gate: {
      async request(req) {
        requests.push(req);
        return "allow";
      },
    },
  };
  try {
    const t = routineTool(ctx) as any;
    await fn((input) => t.execute(input, {}), requests);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("routine tool: MCP selectors are labeled in the approval and force alwaysAsk", async () => {
  await withRoutineTool(async (execute, requests) => {
    await execute({
      name: "welcome-clients",
      cron: "*/5 * * * *",
      prompt: "message new rows",
      tools: ["sheets__get_rows", "whatsapp__send_template"],
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0].detail, /grants external MCP tools, unattended: sheets__get_rows, whatsapp__send_template/);
    assert.equal(requests[0].alwaysAsk, true);

    // The grant is persisted on the saved routine.
    const saved = loadRoutines();
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].tools, ["sheets__get_rows", "whatsapp__send_template"]);
  });
});

test("routine tool: email + MCP selectors show both flags", async () => {
  await withRoutineTool(async (execute, requests) => {
    await execute({
      name: "digest",
      cron: "0 8 * * *",
      prompt: "p",
      delivery: ["email"],
      tools: ["sheets__*"],
    });
    assert.match(requests[0].detail, /\[email leaves your machine\]/);
    assert.match(requests[0].detail, /\[grants external MCP tools, unattended: sheets__\*\]/);
    assert.equal(requests[0].alwaysAsk, true);
  });
});

test("routine tool: plain routine has no egress flags and no alwaysAsk", async () => {
  await withRoutineTool(async (execute, requests) => {
    await execute({ name: "news", cron: "0 8 * * *", prompt: "p" });
    assert.ok(!/\[/.test(requests[0].detail), "no flag brackets in detail");
    assert.ok(!requests[0].alwaysAsk);
    assert.equal(loadRoutines()[0].tools, undefined);
  });
});

test("routine tool: webhook delivery must reference a configured endpoint", async () => {
  await withRoutineTool(async (execute, requests) => {
    const res = await execute({
      name: "digest",
      cron: "0 8 * * *",
      prompt: "p",
      delivery: ["webhook:team"],
    });
    assert.match(String(res), /webhook not configured: team/);
    assert.equal(requests.length, 0, "fails before the approval prompt");
    assert.equal(loadRoutines().length, 0, "nothing saved");
  });
});

test("routine tool: configured webhook is flagged with its host at approval", async () => {
  await withRoutineTool(async (execute, requests) => {
    writeFileSync(
      join(process.env.PRIVATEER_HOME!, "config.json"),
      JSON.stringify({ webhooks: { team: { url: "https://hooks.slack.com/services/T00/B00/x", format: "slack" } } }),
      "utf8",
    );
    await execute({ name: "digest", cron: "0 8 * * *", prompt: "p", delivery: ["file", "webhook:team"] });
    assert.equal(requests.length, 1);
    assert.match(requests[0].detail, /posts results off-machine to webhook: team → hooks\.slack\.com/);
    assert.ok(!requests[0].alwaysAsk, "webhook flag alone does not force alwaysAsk");
    assert.deepEqual(loadRoutines()[0].delivery, ["file", "webhook:team"]);
  });
});

test("routine tool: builtin-only tools list does not trigger the MCP flag", async () => {
  await withRoutineTool(async (execute, requests) => {
    await execute({ name: "scan", cron: "0 8 * * *", prompt: "p", tools: ["read", "grep"] });
    assert.ok(!/grants external MCP tools/.test(requests[0].detail));
    assert.ok(!requests[0].alwaysAsk);
    assert.deepEqual(loadRoutines()[0].tools, ["read", "grep"]);
  });
});
