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
    // The tool-prefix mode is PINNED: a routine's "<server>__<tool>" selector is
    // translated into a registered tool name using it (src/mcp/toolNames.ts), so a
    // change of adapter default must not silently void every per-routine allow-list.
    assert.equal(readProj(dir).settings.toolPrefix, "server");

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

// A bearer connector is the case the projection used to be unable to express at all —
// the only way to get one was to hand-edit mcp-desktop.json.
test("mcpControl: a bearer token projects auth:bearer, which is what actually sends it", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    assert.ok(
      ctrl.save({
        name: "acme",
        transport: "http",
        url: "https://mcp.acme.test/mcp",
        bearerToken: "sk_live_abc",
        headers: { "X-Api-Version": "2" },
      }).ok,
    );

    const proj = readProj(dir).mcpServers.acme;
    // server-manager.ts adds the Authorization header ONLY when auth === "bearer".
    // Storing the token without this is storing a token that never gets sent.
    assert.equal(proj.auth, "bearer");
    assert.equal(proj.bearerToken, "sk_live_abc");
    assert.deepEqual(proj.headers, { "X-Api-Version": "2" });
    assert.equal(proj.oauth, undefined, "the legacy boolean must never reach the adapter");

    // The RELAY projection names the secrets without ever echoing one.
    const item = ctrl.list().find((s) => s.name === "acme")!;
    assert.equal(item.auth, "bearer");
    assert.equal(item.oauth, false, "a bearer connector does not do OAuth");
    assert.equal(item.bearerTokenSet, true);
    assert.deepEqual(item.headerKeys, ["X-Api-Version"]);
    assert.deepEqual(item.headersSet, ["X-Api-Version"]);
    assert.ok(!JSON.stringify(item).includes("sk_live_abc"), "the token must never cross the relay");
  });
});

test("mcpControl: bearerTokenEnv is a NAME, so it rides in the clear and needs no token", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    assert.ok(ctrl.save({ name: "acme", transport: "http", url: "https://a.test/mcp", bearerTokenEnv: "ACME_TOKEN" }).ok);
    const item = ctrl.list().find((s) => s.name === "acme")!;
    assert.equal(item.auth, "bearer");
    assert.equal(item.bearerTokenEnv, "ACME_TOKEN");
    assert.equal(item.bearerTokenSet, false, "no literal token is stored");
    assert.equal(readProj(dir).mcpServers.acme.bearerTokenEnv, "ACME_TOKEN");
  });
});

test("mcpControl: auth:bearer with nothing to send is refused, not silently saved", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    const res = ctrl.save({ name: "acme", transport: "http", url: "https://a.test/mcp", auth: "bearer" });
    assert.equal(res.ok, false);
    assert.equal(ctrl.list().length, 0, "nothing written on a refusal");
  });
});

test("mcpControl: re-saving without re-typing keeps the stored token and headers", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    ctrl.save({
      name: "acme",
      transport: "http",
      url: "https://a.test/mcp",
      bearerToken: "sk_live_abc",
      headers: { "X-One": "1", "X-Two": "2" },
    });
    // An edit that only moves the URL: no secrets submitted at all.
    assert.ok(ctrl.save({ name: "acme", url: "https://b.test/mcp" }).ok);
    const proj = readProj(dir).mcpServers.acme;
    assert.equal(proj.url, "https://b.test/mcp");
    assert.equal(proj.bearerToken, "sk_live_abc", "an omitted token keeps the stored one");
    assert.deepEqual(proj.headers, { "X-One": "1", "X-Two": "2" });

    // An explicit empty string is the clear signal, for both shapes.
    assert.ok(ctrl.save({ name: "acme", bearerTokenEnv: "ACME_TOKEN", bearerToken: "", headers: { "X-Two": "" } }).ok);
    const after = readProj(dir).mcpServers.acme;
    assert.equal(after.bearerToken, undefined);
    assert.deepEqual(after.headers, { "X-One": "1" });
    assert.equal(after.auth, "bearer", "still bearer — the env var now supplies the token");
  });
});

test("mcpControl: switching a connector to stdio drops every http credential", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    ctrl.save({ name: "acme", transport: "http", url: "https://a.test/mcp", bearerToken: "sk_live_abc", headers: { "X-One": "1" } });
    assert.ok(ctrl.save({ name: "acme", transport: "stdio", command: "npx" }).ok);
    const raw = readSrc(dir).servers.acme;
    // A live token left behind on a transport that can't use it is a secret nobody
    // knows is still on disk.
    assert.equal(raw.bearerToken, undefined);
    assert.equal(raw.headers, undefined);
    assert.equal(raw.auth, undefined);
    assert.equal(raw.url, undefined);
    const item = ctrl.list().find((s) => s.name === "acme")!;
    assert.equal(item.bearerTokenSet, false);
    assert.deepEqual(item.headerKeys, []);
  });
});

test("mcpControl: a legacy oauth:false entry keeps meaning 'no auth'", () => {
  withDir((dir) => {
    // A file written before `auth` existed.
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "mcp-desktop.json"),
      JSON.stringify({ servers: { old: { url: "https://old.test/mcp", oauth: false, enabled: true } } }),
    );
    const ctrl = makeMcpControl({ dir: () => dir });
    const item = ctrl.list().find((s) => s.name === "old")!;
    assert.equal(item.auth, "none");
    assert.equal(item.oauth, false);
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

// ── the relay boundary: which fields may travel in the clear ──────────────────
//
// mergeSealedMcpSecrets is the harbor's half of the save (applyMcpSave calls it). A signed
// frame proves the ACCOUNT authored the draft; it does nothing to stop the relay from
// READING it. So every credential-bearing field has to come out of the sealed box.
import { mergeSealedMcpSecrets } from "../src/remote/mcpControl.ts";

test("mcpSave: a credential sent in the clear is refused, not quietly dropped", () => {
  for (const field of ["env", "headers", "bearerToken"]) {
    const draft: Record<string, unknown> = { name: "acme", url: "https://a.test/mcp" };
    draft[field] = field === "bearerToken" ? "sk_live_abc" : { K: "v" };
    const res = mergeSealedMcpSecrets(draft);
    assert.equal(res.ok, false, `${field} was accepted unsealed`);
    // Silently stripping it would look, to the user, like a save that worked.
    assert.match((res as { message: string }).message, new RegExp(field));
  }
});

test("mcpSave: bearerTokenEnv is a NAME and travels in the clear", () => {
  const res = mergeSealedMcpSecrets({ name: "acme", url: "https://a.test/mcp", bearerTokenEnv: "ACME_TOKEN" });
  assert.equal(res.ok, true);
});

test("mcpSave: the sealed box supplies the secrets; an absent field keeps what's stored", () => {
  const res = mergeSealedMcpSecrets(
    { name: "acme", url: "https://a.test/mcp" },
    { bearerToken: "sk_live_abc" },
  );
  assert.equal(res.ok, true);
  const merged = (res as { draft: Record<string, unknown> }).draft;
  assert.equal(merged.bearerToken, "sk_live_abc");
  // NOT set to {} — mcpControl reads an absent key as "leave the stored value alone",
  // so writing an empty object here would churn the file on every no-secret edit.
  assert.equal(merged.env, undefined);
  assert.equal(merged.headers, undefined);
});

test("mcpControl: custom headers with no token mean 'the headers ARE the credential'", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    assert.ok(ctrl.save({ name: "acme", transport: "http", url: "https://a.test/mcp", headers: { Authorization: "Basic xyz" } }).ok);
    // Mirrors pi-mcp-adapter's supportsOAuth: headers beat implicit OAuth auto-detect.
    // Projecting an explicit auth:"oauth" here would FORCE OAuth on, because the adapter
    // checks auth === "oauth" before it checks headers.
    assert.equal(readProj(dir).mcpServers.acme.auth, false);
    assert.equal(ctrl.list().find((s) => s.name === "acme")!.auth, "none");
  });
});

test("mcpControl: an EXPLICIT auth still wins over the headers rule", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    assert.ok(
      ctrl.save({ name: "acme", transport: "http", url: "https://a.test/mcp", auth: "oauth", headers: { "X-Api-Version": "2" } }).ok,
    );
    assert.equal(readProj(dir).mcpServers.acme.auth, "oauth");
  });
});
