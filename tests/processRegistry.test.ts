import { test } from "node:test";
import assert from "node:assert/strict";
import { ProcessRegistry } from "../src/tools/processRegistry.ts";
import { bashTool, bashOutputTool, killShellTool } from "../src/tools/bash.ts";
import { autoApproveGate } from "../src/permissions/gate.ts";

async function until(pred: () => boolean, timeout = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}
const exited = (reg: ProcessRegistry, id: string) => () =>
  reg.list().find((p) => p.id === id)?.status === "exited";

test("ProcessRegistry runs a background command and reads output incrementally", async () => {
  const reg = new ProcessRegistry();
  const id = reg.spawn("printf 'hello world'", process.cwd());
  assert.ok(await until(exited(reg, id)), "process should exit");
  const r = reg.read(id);
  assert.equal(r?.status, "exited");
  assert.equal(r?.code, 0);
  assert.match(r?.output ?? "", /hello world/);
  // A second read returns no new output.
  assert.equal(reg.read(id)?.output, "");
});

test("ProcessRegistry kills a long-running shell; unknown ids are handled", () => {
  const reg = new ProcessRegistry();
  const id = reg.spawn("sleep 30", process.cwd());
  assert.equal(reg.kill(id), true);
  assert.equal(reg.list().find((p) => p.id === id)?.status, "exited");
  assert.equal(reg.read("nope"), null);
  assert.equal(reg.kill("nope"), false);
});

test("bash run_in_background returns an id that bash_output can read", async () => {
  const reg = new ProcessRegistry();
  const ctx = { cwd: process.cwd(), gate: autoApproveGate, processes: reg };
  const started = (await (bashTool(ctx) as any).execute(
    { command: "printf finished", run_in_background: true },
    {},
  )) as string;
  const m = started.match(/bash_\d+/);
  assert.ok(m, "returns a background id");
  const id = m![0];
  assert.ok(await until(exited(reg, id)));
  const out = (await (bashOutputTool(ctx) as any).execute({ bash_id: id }, {})) as string;
  assert.match(out, /finished/);
  const miss = (await (killShellTool(ctx) as any).execute({ bash_id: "nope" }, {})) as string;
  assert.match(miss, /No background shell/);
});
