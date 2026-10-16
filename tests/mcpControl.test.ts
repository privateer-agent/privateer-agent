import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMcpControl, toPiConfigValue, migrateMcpProjection } from "../src/remote/mcpControl.ts";
// Not in the package exports — Pi's own config validation and value expansion, so the
// projection is checked against what Pi will actually accept and resolve.
import { validateMcpServerConfig } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js";
import { resolveConfigValue } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js";

// Every projected entry must pass Pi's validator — an entry it rejects is a connector
// that silently disappears.
function assertPiAccepts(dir: string): void {
  for (const [name, entry] of Object.entries<any>(readProj(dir).mcpServers)) {
    const r = validateMcpServerConfig(name, entry);
    assert.equal(typeof r, "object", `Pi rejects "${name}": ${r}`);
  }
}

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

    // Projected into the standard mcp.json Pi reads, WITHOUT our `enabled` flag.
    const proj = readProj(dir).mcpServers.github;
    assert.ok(proj, "github projected");
    assert.equal(proj.enabled, undefined, "projection is standard shape (no enabled)");
    assert.equal(proj.command, "npx");
    assert.deepEqual(proj.args, ["-y", "@modelcontextprotocol/server-github"]);
    // The projection DOES carry the env (Pi needs it locally) — the secrecy boundary is
    // the RELAY (list()), not the on-disk file.
    assert.equal(proj.env.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_secret123");
    // No adapter-era settings block: its toolPrefix pin is the migration marker.
    assert.equal(readProj(dir).settings, undefined);
    assertPiAccepts(dir);

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
    assert.ok(ctrl.save({ name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", oauth: true }).ok);
    const item = ctrl.list().find((s) => s.name === "linear")!;
    assert.equal(item.transport, "http");
    assert.equal(item.url, "https://mcp.linear.app/mcp");
    assert.equal(item.host, "mcp.linear.app", "host parsed for the badge");
    assert.equal(item.oauth, true);
    assert.deepEqual(item.envKeys, []);
    const proj = readProj(dir).mcpServers.linear;
    assert.equal(proj.url, "https://mcp.linear.app/mcp");
    // OAuth needs no field: Pi offers sign-in when a server without an Authorization
    // header answers 401. Our "oauth" string would make Pi reject the entry outright.
    assert.equal(proj.auth, undefined);
    assert.equal(proj.headers, undefined);
    assertPiAccepts(dir);
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
    // Pi has no bearer field: the token travels as an Authorization header, which is
    // also what stops Pi from starting OAuth for this server.
    assert.deepEqual(proj.headers, { "X-Api-Version": "2", Authorization: "Bearer sk_live_abc" });
    assert.equal(proj.auth, undefined, "our auth string must never reach Pi");
    assert.equal(proj.bearerToken, undefined);
    assert.equal(proj.oauth, undefined, "the legacy boolean must never reach Pi");
    assertPiAccepts(dir);

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
    // Pi reads the variable when it connects.
    assert.equal(readProj(dir).mcpServers.acme.headers.Authorization, "Bearer ${ACME_TOKEN}");
    assert.equal(
      resolveConfigValue(readProj(dir).mcpServers.acme.headers.Authorization, { ACME_TOKEN: "tok" }),
      "Bearer tok",
    );
    assertPiAccepts(dir);
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
    assert.deepEqual(
      proj.headers,
      { "X-One": "1", "X-Two": "2", Authorization: "Bearer sk_live_abc" },
      "an omitted token keeps the stored one",
    );

    // An explicit empty string is the clear signal, for both shapes.
    assert.ok(ctrl.save({ name: "acme", bearerTokenEnv: "ACME_TOKEN", bearerToken: "", headers: { "X-Two": "" } }).ok);
    const after = readProj(dir).mcpServers.acme;
    // Still bearer — the env var now supplies the token.
    assert.deepEqual(after.headers, { "X-One": "1", Authorization: "Bearer ${ACME_TOKEN}" });
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
    // Pi's own `enabled: false`: listed, never connected — and `mcp login` can find it.
    assert.equal(readProj(dir).mcpServers.echo.enabled, false, "disabled → switched off in the projection");
    assert.equal(ctrl.list().find((s) => s.name === "echo")!.enabled, false, "still in managed list");

    assert.ok(ctrl.setEnabled("echo", true).ok);
    assert.equal(readProj(dir).mcpServers.echo.enabled, undefined, "re-enabled → on again (Pi's default)");
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
    // Headers beat implicit OAuth: the header is projected as typed, and Pi doesn't
    // start OAuth for a server that carries an Authorization header.
    assert.deepEqual(readProj(dir).mcpServers.acme.headers, { Authorization: "Basic xyz" });
    assert.equal(ctrl.list().find((s) => s.name === "acme")!.auth, "none");
  });
});

test("mcpControl: an EXPLICIT auth still wins over the headers rule", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    assert.ok(
      ctrl.save({ name: "acme", transport: "http", url: "https://a.test/mcp", auth: "oauth", headers: { "X-Api-Version": "2" } }).ok,
    );
    assert.equal(ctrl.list().find((s) => s.name === "acme")!.auth, "oauth");
    assertPiAccepts(dir);
  });
});

// Values were typed for pi-mcp-adapter, and Pi reads a different syntax. Each one must
// resolve under Pi to exactly what the adapter resolved it to. The oracle is the
// adapter's own rule, copied from pi-mcp-adapter 2.34.0 utils.ts
// (interpolateEnvVars + the "!!" escape in resolveCommandSecret).
function adapterResolve(value: string, env: Record<string, string>): string {
  const interp = (v: string) =>
    v
      .replace(/\$\{(\w+)\}/g, (_, n) => env[n] ?? "")
      .replace(/\$env:(\w+)/g, (_, n) => env[n] ?? "")
      .replace(/\{env:(\w+)\}/g, (_, n) => env[n] ?? "");
  return value.startsWith("!!") ? interp(value.slice(1)) : interp(value);
}

test("mcpControl: every value resolves under Pi to what the adapter made of it", () => {
  const env = { TOKEN: "t0k", HOME: "/h", A_B: "ab" };
  const values = [
    "plain", "pa$word", "$HOME", "$$", "a$", "${TOKEN}", "Bearer ${TOKEN}", "$env:TOKEN", "{env:TOKEN}",
    "x${TOKEN}y$env:A_B-{env:HOME}$z", "!!literal bang", "!!${TOKEN}", "!!!x", "a$!b", "${NOT A VAR}", "",
  ];
  for (const v of values) {
    assert.equal(resolveConfigValue(toPiConfigValue(v), env), adapterResolve(v, env), JSON.stringify(v));
  }
  // A command stays a command — the adapter ran it too.
  assert.equal(toPiConfigValue("!op read op://vault/token"), "!op read op://vault/token");
});

test("mcpControl: a bearer token keeps its meaning inside the Authorization header", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    ctrl.save({ name: "lit", transport: "http", url: "https://a.test/mcp", bearerToken: "pa$word" });
    ctrl.save({ name: "ref", transport: "http", url: "https://a.test/mcp", bearerToken: "${TOKEN}" });
    ctrl.save({ name: "cmd", transport: "http", url: "https://a.test/mcp", bearerToken: "!echo from-cmd" });
    const proj = readProj(dir).mcpServers;
    assert.equal(resolveConfigValue(proj.lit.headers.Authorization, {}), "Bearer pa$word");
    assert.equal(resolveConfigValue(proj.ref.headers.Authorization, { TOKEN: "t0k" }), "Bearer t0k");
    // The adapter ran the command and added "Bearer "; Pi runs only a whole value.
    assert.equal(resolveConfigValue(proj.cmd.headers.Authorization, {}), "Bearer from-cmd");
    assertPiAccepts(dir);
  });
});

test("mcpControl: a connector saved on a legacy SSE endpoint keeps working and stays editable", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "mcp-desktop.json"),
      JSON.stringify({ servers: { asana: { transport: "http", url: "https://mcp.asana.com/sse", auth: "oauth", enabled: true } } }),
    );
    const ctrl = makeMcpControl({ dir: () => dir });
    ctrl.reproject();
    assert.equal(readProj(dir).mcpServers.asana.url, "https://mcp.asana.com/mcp", "projected on the streamable URL");
    // An edit that doesn't touch the URL is not refused for the URL it was saved with.
    assert.equal(ctrl.save({ name: "asana", headers: { "X-Team": "a" } }).ok, true);
    assert.equal(readSrc(dir).servers.asana.url, "https://mcp.asana.com/mcp");
  });
});

test("mcpControl: names Pi would reject, SSE endpoints and bad variable names are refused at save", () => {
  withDir((dir) => {
    const ctrl = makeMcpControl({ dir: () => dir });
    assert.equal(ctrl.save({ name: "my server", transport: "stdio", command: "x" }).ok, false);
    assert.equal(ctrl.save({ name: "old", transport: "http", url: "https://mcp.example.com/sse" }).ok, false);
    assert.equal(ctrl.save({ name: "old", transport: "http", url: "https://mcp.example.com/v1/sse/" }).ok, false);
    assert.equal(
      ctrl.save({ name: "acme", transport: "http", url: "https://a.test/mcp", bearerTokenEnv: "NOT A VAR" }).ok,
      false,
    );
    assert.equal(ctrl.list().length, 0, "nothing written on a refusal");
  });
});

// An older release wrote mcp.json for pi-mcp-adapter: `auth` strings, `bearerToken`
// fields, and a settings.toolPrefix pin. Pi rejects every HTTP entry in that shape.
test("mcpControl: an adapter-era mcp.json is re-projected once, and a Pi-format one is left alone", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "mcp-desktop.json"),
      JSON.stringify({
        servers: {
          acme: { transport: "http", url: "https://a.test/mcp", auth: "bearer", bearerToken: "tok", enabled: true },
          linear: { transport: "http", url: "https://mcp.linear.app/mcp", auth: "oauth", enabled: true },
          off: { transport: "stdio", command: "x", enabled: false },
        },
      }),
    );
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          acme: { url: "https://a.test/mcp", auth: "bearer", bearerToken: "tok" },
          linear: { url: "https://mcp.linear.app/mcp", auth: "oauth" },
          handadded: { url: "https://mcp.atlassian.com/v1/sse", auth: "oauth" },
        },
        settings: { toolPrefix: "server" },
      }),
    );
    assert.equal(migrateMcpProjection(() => dir), true);
    const proj = readProj(dir);
    assert.equal(proj.settings, undefined);
    assert.deepEqual(proj.mcpServers.acme.headers, { Authorization: "Bearer tok" });
    assert.equal(proj.mcpServers.linear.auth, undefined);
    assert.equal(proj.mcpServers.off.enabled, false, "a disabled server stays listed, switched off");
    assertPiAccepts(dir);
    // Only in the old mcp.json (a hand edit): adopted into mcp-desktop.json, not lost —
    // and moved off the legacy SSE endpoint Pi can't speak.
    assert.equal(proj.mcpServers.handadded.url, "https://mcp.atlassian.com/v1/mcp");
    assert.equal(readSrc(dir).servers.handadded.enabled, true);

    // Already migrated (or hand-written for Pi): untouched, ${VAR} references included.
    const handWritten = { mcpServers: { docs: { url: "https://d.test/mcp", headers: { Authorization: "Bearer ${DOCS}" } } } };
    writeFileSync(join(dir, "mcp.json"), JSON.stringify(handWritten));
    assert.equal(migrateMcpProjection(() => dir), false);
    assert.deepEqual(readProj(dir), handWritten);
  });
});
