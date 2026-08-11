import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_CATALOG, catalogEntry, draftFromCatalog, promptOrder, hostedCapable } from "../src/mcp/catalog.ts";
import { makeMcpControl } from "../src/remote/mcpControl.ts";

// The catalog's own header says it: "a broken command in the catalog is worse than an
// omission" — a user who picks GitHub from /connect and gets a server that can never
// start has no way to tell that from MCP itself being broken. These invariants are
// what the picker and the wizard both assume, so they're worth failing the build over.
test("catalog: every entry is internally consistent", () => {
  const seen = new Set<string>();
  for (const e of MCP_CATALOG) {
    const where = `entry "${e.id}"`;
    assert.ok(!seen.has(e.id), `${where}: duplicate id`);
    seen.add(e.id);
    assert.ok(e.name && !/\s/.test(e.name), `${where}: name must be non-empty and space-free`);
    assert.ok(e.label && e.blurb, `${where}: needs a label and a blurb`);

    if (e.transport === "stdio") {
      assert.ok(e.command, `${where}: stdio needs a command`);
      assert.equal(e.url, undefined, `${where}: stdio must not carry a url`);
    } else {
      // https, OR plain http on loopback. The exception is narrow on purpose: a
      // localHttp entry (Unreal) talks to a server inside another process on this
      // machine, which has no certificate and needs none — nothing crosses a network.
      // Anything reachable off-box still has to be https.
      const loopback = /^http:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/i.test(e.url ?? "");
      assert.ok(
        e.url?.startsWith("https://") || (loopback && e.localHttp === true),
        `${where}: http needs an https url (or plain http on loopback, with localHttp)`,
      );
      assert.equal(e.command, undefined, `${where}: http must not carry a command`);
    }

    if (e.needs === "token") {
      const keys = Object.keys(e.env ?? {});
      assert.ok(keys.length > 0, `${where}: needs:token must declare env keys`);
      assert.ok(e.fill && keys.includes(e.fill), `${where}: fill must name one of its env keys`);
    }
    if (e.needs === "path") {
      assert.ok(e.fill, `${where}: needs:path must declare a fill placeholder`);
      assert.ok(
        (e.args ?? []).includes(e.fill!),
        `${where}: the fill placeholder must actually appear in args`,
      );
    }
    if (e.needs === "oauth") {
      assert.equal(e.transport, "http", `${where}: only http servers negotiate OAuth`);
    }
    if (e.needs === "url") {
      // The wizard pre-fills this step from `url`; without one it would ask the user
      // to confirm an empty field.
      assert.equal(e.transport, "http", `${where}: needs:url is an http-only shape`);
      assert.ok(e.url, `${where}: needs:url must carry a default url to confirm`);
    }
    if (e.localHttp) {
      // The two things that make it local rather than remote. `hosted: false` is not
      // belt-and-braces: hostedCapable()'s derived rule keys on `oauth`, so an entry
      // that forgot it would be silently offered to a Harbor tenant that has no route
      // to the user's loopback at all.
      assert.equal(e.transport, "http", `${where}: localHttp is an http shape`);
      assert.equal(e.oauth, undefined, `${where}: a localHttp server authenticates to nothing`);
      assert.equal(e.hosted, false, `${where}: localHttp must be explicitly hosted:false`);
    }
  }
});

test("catalog: promptOrder puts the primary credential first", () => {
  // Slack is the entry with more than one key — the bot token must be asked for
  // before the incidental team id.
  const slack = catalogEntry("slack")!;
  assert.deepEqual(promptOrder(slack), ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"]);
  // An entry with no env at all yields no prompts rather than throwing.
  assert.deepEqual(promptOrder(catalogEntry("memory")!), []);
});

test("catalog: draftFromCatalog fills a token by key", () => {
  const draft = draftFromCatalog(catalogEntry("github")!, {
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_live" },
  });
  assert.equal(draft.transport, "stdio");
  assert.equal(draft.command, "npx");
  assert.deepEqual(draft.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.equal(draft.env?.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_live");
});

test("catalog: draftFromCatalog replaces the path placeholder by VALUE, not index", () => {
  const fs = catalogEntry("filesystem")!;
  const draft = draftFromCatalog(fs, { fill: "/Users/me/notes" });
  assert.deepEqual(draft.args, ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"]);
  // Nothing typed → the placeholder survives verbatim rather than becoming "undefined".
  assert.deepEqual(draftFromCatalog(fs, {}).args, fs.args);
});

test("catalog: an oauth entry drafts as http with no env", () => {
  const draft = draftFromCatalog(catalogEntry("linear")!);
  assert.equal(draft.transport, "http");
  // /sse is dead (404s on GET and POST); Linear moved to Streamable HTTP at /mcp.
  assert.equal(draft.url, "https://mcp.linear.app/mcp");
  // The adapter's vocabulary, not the legacy boolean — its own `oauth` field is an
  // OAuthConfig object, so a boolean there was always an abuse of the schema.
  assert.equal(draft.auth, "oauth");
  assert.equal(draft.oauth, undefined);
  assert.equal(draft.env, undefined);
  assert.equal(draft.command, undefined);
});

// A localHttp entry authenticates to NOTHING, and that has to survive into the draft.
// `auth: "oauth"` here would not fail at save time — it fails at connect time, when the
// adapter goes looking for an authorization server the Unreal Editor does not have.
test("catalog: a localHttp entry drafts with auth none and an editable url", () => {
  const unreal = catalogEntry("unreal")!;
  const dflt = draftFromCatalog(unreal);
  assert.equal(dflt.transport, "http");
  assert.equal(dflt.auth, "none");
  assert.equal(dflt.url, "http://127.0.0.1:8000/mcp");
  assert.equal(dflt.env, undefined);
  assert.equal(dflt.command, undefined);

  // The port and path are user-editable in Unreal, so a typed URL must win...
  assert.equal(draftFromCatalog(unreal, { url: "http://127.0.0.1:9100/mcp" }).url, "http://127.0.0.1:9100/mcp");
  // ...but an empty answer keeps the documented default rather than blanking the url.
  assert.equal(draftFromCatalog(unreal, { url: "   " }).url, unreal.url);
});

// Option B (docs/HARBOR_CONNECTORS_PLAN.md §2): a hosted agent gets remote HTTP OAuth
// connectors and nothing else — no stdio (it would execute unmeasured third-party code
// inside an attested enclave) and no static token (it would need a durable secret at
// rest we could read). This is the picker filter; if it ever admits a stdio entry,
// the hosted picker is offering something the runtime cannot hold.
test("catalog: hostedCapable admits exactly the remote OAuth connectors", () => {
  const hosted = MCP_CATALOG.filter(hostedCapable);
  assert.ok(hosted.length > 0, "no hosted-capable connectors at all");
  for (const e of hosted) {
    assert.equal(e.transport, "http", `${e.id} is not remote HTTP`);
    assert.equal(e.oauth, true, `${e.id} is not an OAuth connector`);
    assert.equal(e.command, undefined, `${e.id} would spawn a local process`);
    assert.deepEqual(Object.keys(e.env ?? {}), [], `${e.id} needs a stored credential`);
  }
  for (const e of MCP_CATALOG.filter((x) => !hostedCapable(x))) {
    assert.ok(e.transport === "stdio" || e.oauth !== true, `${e.id} was excluded for no reason`);
  }
});

test("catalog: an explicit hosted flag overrides the derived answer", () => {
  const oauthEntry = MCP_CATALOG.find((e) => hostedCapable(e))!;
  assert.equal(hostedCapable({ ...oauthEntry, hosted: false }), false);
  const stdioEntry = MCP_CATALOG.find((e) => e.transport === "stdio")!;
  assert.equal(hostedCapable({ ...stdioEntry, hosted: true }), true);
});

// The full shape the /connect panel actually produces: catalog → draft →
// mcpControl.save → the projection pi-mcp-adapter reads. If these two modules ever
// disagree about a field name, this is where it shows up.
test("catalog: every entry saves cleanly through mcpControl", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-cat-"));
  try {
    const ctrl = makeMcpControl({ dir: () => dir });
    for (const e of MCP_CATALOG) {
      // Fill whatever the entry demands, so nothing fails on a missing required field.
      const env: Record<string, string> = {};
      for (const k of promptOrder(e)) env[k] = `test-${k}`;
      const res = ctrl.save(draftFromCatalog(e, { env, fill: "/tmp/x" }));
      assert.ok(res.ok, `${e.id}: ${res.message}`);
    }
    const listed = ctrl.list();
    assert.equal(listed.length, MCP_CATALOG.length);
    // The projection never leaks a credential VALUE back to a caller.
    const github = listed.find((s) => s.name === "github")!;
    assert.deepEqual(github.secretsSet, ["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    assert.ok(!JSON.stringify(listed).includes("test-GITHUB_PERSONAL_ACCESS_TOKEN"));
    // A localHttp entry comes back as an http connector that is NOT an OAuth one.
    // mcpControl's authOf() defaults an http entry to "oauth" whenever nothing says
    // otherwise, so this is the round trip that proves the "otherwise" survived.
    const unreal = listed.find((s) => s.name === "unreal")!;
    assert.equal(unreal.transport, "http");
    assert.equal(unreal.auth, "none");
    assert.equal(unreal.oauth, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
