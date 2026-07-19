import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMcpControl } from "../src/remote/mcpControl.ts";

// Run `fn` with a throwaway agent dir so mcpControl reads/writes an isolated
// mcp-desktop.json + mcp.json, cleaning up after.
function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "priv-mcp-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const readProj = (dir: string) =>
  existsSync(join(dir, "mcp.json")) ? JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")) : { mcpServers: {} };
const readSrc = (dir: string) =>
  existsSync(join(dir, "mcp-desktop.json")) ? JSON.parse(readFileSync(join(dir, "mcp-desktop.json"), "utf8")) : { servers: {} };

test("mcpControl: save stdio projects into mcp.json and lists non-secret", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    const res = ctrl.save({
      name: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret123" },
    });
    assert.ok(res.ok, res.message);

    // Projected into the standard mcp.json the adapter reads, WITHOUT our `enabled` flag.
    const proj = readProj(dir).mcpServers.github;
    assert.ok(proj, "github projected");
    assert.equal(proj.enabled, undefined, "projection is standard shape (no enabled)");
    assert.equal(proj.command, "npx");
    assert.deepEqual(proj.args, ["-y", "@modelcontextprotocol/server-github"]);
    // The projection DOES carry the env (the adapter needs it locally) — the secrecy
    // boundary is the RELAY (list()), not the on-disk file.
    assert.equal(proj.env.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_secret123");

    // list() is the RELAY projection — it must NEVER echo a token value.
    const item = ctrl.list().find((s) => s.name === "github")!;
    assert.equal(item.transport, "stdio");
    assert.equal(item.enabled, true);
    assert.equal(item.oauth, false, "stdio is never oauth");
    assert.deepEqual(item.envKeys, ["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    assert.deepEqual(item.secretsSet, ["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    // No field anywhere in the relay projection should contain the secret value.
    assert.ok(!JSON.stringify(item).includes("ghp_secret123"), "list() leaks no token value");
  });
});

test("mcpControl: save http infers oauth + surfaces host for the privacy badge", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    assert.ok(ctrl.save({ name: "linear", transport: "http", url: "https://mcp.linear.app/sse", oauth: true }).ok);
    const item = ctrl.list().find((s) => s.name === "linear")!;
    assert.equal(item.transport, "http");
    assert.equal(item.url, "https://mcp.linear.app/sse");
    assert.equal(item.host, "mcp.linear.app", "host parsed for the badge");
    assert.equal(item.oauth, true);
    assert.deepEqual(item.envKeys, []);
    assert.equal(readProj(dir).mcpServers.linear.url, "https://mcp.linear.app/sse");
  });
});

test("mcpControl: transport ⟷ required field is validated", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    assert.equal(ctrl.save({ name: "x", transport: "stdio" }).ok, false, "stdio needs a command");
    assert.equal(ctrl.save({ name: "y", transport: "http" }).ok, false, "http needs a url");
    assert.equal(ctrl.save({ name: "  ", transport: "stdio", command: "npx" }).ok, false, "blank name rejected");
    assert.deepEqual(ctrl.list(), [], "nothing persisted on rejection");
  });
});

test("mcpControl: env merge — omitted keeps, empty clears, present overwrites", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    ctrl.save({ name: "s", transport: "stdio", command: "run", env: { A: "1", B: "2" } });

    // Re-save with NO env → keeps both (re-editing name without re-typing tokens).
    ctrl.save({ name: "s", transport: "stdio", command: "run2" });
    assert.deepEqual(readSrc(dir).servers.s.env, { A: "1", B: "2" }, "omitted env kept");
    assert.equal(readProj(dir).mcpServers.s.command, "run2", "non-secret field updated");

    // Re-save with A="" clears A, B present overwrites, C added.
    ctrl.save({ name: "s", transport: "stdio", command: "run2", env: { A: "", B: "22", C: "3" } });
    assert.deepEqual(readSrc(dir).servers.s.env, { B: "22", C: "3" }, "empty cleared, present overwrote, new added");
    const item = ctrl.list().find((s) => s.name === "s")!;
    assert.deepEqual(item.secretsSet.sort(), ["B", "C"]);
  });
});

test("mcpControl: setEnabled toggles projection but keeps the managed entry", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    ctrl.save({ name: "echo", transport: "stdio", command: "node" });
    assert.ok(readProj(dir).mcpServers.echo, "enabled → projected");

    assert.ok(ctrl.setEnabled("echo", false).ok);
    assert.ok(!readProj(dir).mcpServers.echo, "disabled → dropped from projection");
    assert.equal(ctrl.list().find((s) => s.name === "echo")!.enabled, false, "still in managed list");

    assert.ok(ctrl.setEnabled("echo", true).ok);
    assert.ok(readProj(dir).mcpServers.echo, "re-enabled → back in projection");
    assert.equal(ctrl.setEnabled("nope", true).ok, false, "unknown name rejected");
  });
});

test("mcpControl: remove deletes from source + projection", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    ctrl.save({ name: "gone", transport: "stdio", command: "node" });
    assert.ok(ctrl.remove("gone").ok);
    assert.equal(ctrl.list().length, 0);
    assert.equal(readProj(dir).mcpServers.gone, undefined);
    assert.equal(ctrl.remove("gone").ok, false, "removing twice is not ok");
  });
});

test("mcpControl: seeds from an existing standard mcp.json on first run", () => {
  withDir((dir) => {
    // A machine that had connectors BEFORE this control existed — only mcp.json, no
    // mcp-desktop.json. The control must adopt them (all enabled), not drop them.
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { legacy: { command: "old", args: ["x"] } } }),
    );
    const ctrl = makeMcpControl({ dir: () => dir });
    const item = ctrl.list().find((s) => s.name === "legacy");
    assert.ok(item, "legacy server adopted from mcp.json");
    assert.equal(item!.enabled, true);
  });
});
