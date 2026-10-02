/**
 * The harbor's unattended runs are confined for real.
 *
 * They run with the gate in `bypass` — their safety is the tool allow-list — and
 * bypass allowed reads/writes outside cwd and of protected files outright, so the
 * `confineToCwd: true` the harbor set meant nothing. A default routine (read/grep/
 * find/ls + web_search/web_fetch) could read ~/.ssh or our own auth.json and put it in
 * the next URL it fetched. `hardConfine` refuses both, and additionally treats a read
 * of a credential store as protected even inside cwd (a routine whose cwd is $HOME).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { decideToolCall, type GateController, type ToolCallCtx } from "../src/ext/permissionGate.ts";
import type { PermissionMode } from "../src/config/permissionMode.ts";

const noCtx: ToolCallCtx = {};

// The harbor's gate (harbor/index.ts buildSessionServices), with asks counted.
function harborCtrl(cwd: string, over: Partial<GateController> = {}): GateController & { asks: number } {
  const state = {
    asks: 0,
    getMode: (): PermissionMode => "bypass",
    setMode: () => {},
    allowlist: [] as string[],
    allowedOutsideRoots: [] as string[],
    cwd,
    confineToCwd: true,
    hardConfine: true,
    async localAsk() {
      state.asks++;
      return "deny" as const;
    },
    ...over,
  };
  return state as GateController & { asks: number };
}

function withHome<T>(fn: (home: string, work: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "priv-confine-"));
  const home = join(root, ".privateer");
  const work = join(root, "project");
  mkdirSync(join(home, "agent"), { recursive: true });
  mkdirSync(join(home, "routines", "daily"), { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(home, "agent", "auth.json"), "{}");
  writeFileSync(join(home, "config.json"), "{}");
  writeFileSync(join(home, "routines", "daily", "latest.md"), "# hi");
  writeFileSync(join(work, "notes.md"), "notes");
  writeFileSync(join(work, ".env"), "KEY=1");
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  return fn(home, work).finally(() => {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(root, { recursive: true, force: true });
  });
}

test("harbor confinement: a read outside cwd is refused, not allowed by bypass", () =>
  withHome(async (home, work) => {
    const ctrl = harborCtrl(work);
    const r = await decideToolCall(ctrl, "read", { path: join(home, "routines", "daily", "latest.md") }, noCtx);
    assert.equal(r?.block, true);

    // The same call without hardConfine is what the harbor used to do: allowed.
    const loose = harborCtrl(work, { hardConfine: false });
    assert.equal(await decideToolCall(loose, "read", { path: join(home, "routines", "daily", "latest.md") }, noCtx), undefined);
  }));

test("harbor confinement: credential stores are refused even when cwd contains them", () =>
  withHome(async (home) => {
    // A routine whose cwd is the parent of PRIVATEER_HOME (think: cwd = $HOME).
    const ctrl = harborCtrl(join(home, ".."));
    for (const p of [join(home, "agent", "auth.json"), join(home, "config.json"), join(homedir(), ".ssh", "id_rsa")]) {
      const r = await decideToolCall(ctrl, "read", { path: p }, noCtx);
      assert.equal(r?.block, true, `refused: ${p}`);
    }
    // Subdirectories of our state are ordinary data — a routine reading its own output is fine.
    assert.equal(await decideToolCall(ctrl, "read", { path: join(home, "routines", "daily", "latest.md") }, noCtx), undefined);
    assert.equal(ctrl.asks, 0, "a refusal is a refusal, not a prompt nobody can answer");
  }));

test("harbor confinement: protected files in cwd are refused; ordinary ones are not", () =>
  withHome(async (_home, work) => {
    const ctrl = harborCtrl(work);
    assert.equal((await decideToolCall(ctrl, "read", { path: ".env" }, noCtx))?.block, true);
    assert.equal(await decideToolCall(ctrl, "read", { path: "notes.md" }, noCtx), undefined);
    // Writes in cwd still go through under bypass; writes outside do not.
    assert.equal(await decideToolCall(ctrl, "write", { path: "out.md", content: "x" }, noCtx), undefined);
    assert.equal((await decideToolCall(ctrl, "write", { path: join(work, "..", "elsewhere.md"), content: "x" }, noCtx))?.block, true);
  }));

test("harbor confinement: interactive sessions keep reading their own .env without a prompt", () =>
  withHome(async (_home, work) => {
    // No hardConfine — the TUI's posture. In-cwd reads stay ungated, secrets included.
    const ctrl = harborCtrl(work, { hardConfine: undefined, getMode: () => "default" });
    assert.equal(await decideToolCall(ctrl, "read", { path: ".env" }, noCtx), undefined);
  }));

test("harbor confinement: --no-quarter still means no gate", () =>
  withHome(async (home, work) => {
    const ctrl = harborCtrl(work, { getSkipAllPermissions: () => true });
    assert.equal(await decideToolCall(ctrl, "read", { path: join(home, "agent", "auth.json") }, noCtx), undefined);
  }));
