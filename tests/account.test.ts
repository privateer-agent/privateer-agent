// PRIVATEER_HOME must point somewhere disposable before the auth module resolves
// paths (globalDir reads it lazily, so setting it here is enough).
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-account-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeAccountProvider,
  privateerOAuthProvider,
  dropPersistedAccountCredential,
  ensureAccountArmed,
  fetchAccountCatalog,
  loadCachedCatalogIds,
  seedCatalogIds,
  ownedAccountCredential,
  recoverAccountSession,
  rememberAccountCredential,
  verificationLink,
} from "../src/providers/account.ts";
import { clearCredentials, currentUser, saveCredentials } from "../src/auth/privateer.ts";

// A stand-in for Pi's ExtensionContext + auth store (auth.json), so the tests can see
// exactly which provider entries a teardown or an arm touched.
function fakeStore(initial?: Record<string, unknown>) {
  const data: Record<string, any> = { ...(initial ?? {}) };
  return {
    data,
    ctx: {
      hasUI: false,
      modelRegistry: {
        authStorage: {
          get: (p: string) => data[p],
          set: (p: string, cred: unknown) => {
            data[p] = cred;
          },
          remove: (p: string) => {
            delete data[p];
          },
        },
      },
    },
  };
}

const PARENT = {
  accessToken: "parent-access",
  refreshToken: "parent-refresh",
  user: { id: "u1" },
  serverBaseUrl: "https://stub.privateer.test",
} as any;

// Stub the Privateer API: count spawns, record which refresh token was presented.
function stubServer() {
  const seen: { spawns: number; refreshed: string[] } = { spawns: 0, refreshed: [] };
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith("/auth/session/spawn")) {
      seen.spawns++;
      return json({ accessToken: "child-access", refreshToken: "child-refresh" });
    }
    if (url.endsWith("/auth/refresh")) {
      seen.refreshed.push(String(body.refreshToken));
      return json({ accessToken: "rotated-access", refreshToken: "rotated-refresh" });
    }
    return json({});
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

// Regression: Pi's /login builds its "Use a subscription" list from the OAuth
// providers registered via registerProvider({ oauth }). The account provider used to
// gate registration on hasCredentials(), so a fresh machine (no credentials) got NO
// Privateer option under /login — you couldn't log in because you weren't logged in.
// It must now register unconditionally so first-login works through provider auth.

test("makeAccountProvider registers the privateer OAuth provider with NO credentials", () => {
  clearCredentials();
  const calls: { name: string; config: any }[] = [];
  makeAccountProvider()({
    registerProvider: (name: string, config: unknown) => calls.push({ name, config: config as any }),
  });

  const priv = calls.find((c) => c.name === "privateer");
  assert.ok(priv, "privateer provider must be registered even when signed out");
  assert.ok(priv!.config.oauth, "registration must include the oauth login path");
  assert.equal(priv!.config.oauth.name, "Privateer account");
  assert.ok(Array.isArray(priv!.config.models) && priv!.config.models.length > 0, "must seed models");
});

test("makeAccountProvider is a no-op when the host lacks registerProvider", () => {
  clearCredentials();
  assert.doesNotThrow(() => makeAccountProvider()({}));
});

// Regression: Pi's login dialog cancels via an AbortController and passes its
// `signal` to provider.login(). login() MUST thread that signal into the device
// poll — otherwise escape/ctrl+c aborts the signal but the poll loop never sees
// it, login() never settles, and the "Waiting for authentication…" screen hangs
// with no way out. This drives a fresh (no-credentials) login with a stub server
// and asserts an abort mid-poll rejects promptly with the exact "Login cancelled"
// string Pi suppresses (no trailing period, no spurious error toast).
test("login() aborts the device poll when the dialog signal fires", async () => {
  clearCredentials();
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  const realFetch = globalThis.fetch;
  const controller = new AbortController();

  // Stub: hand out a device code, then keep saying "authorization_pending" so the
  // only way out of the poll is the abort signal.
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.endsWith("/auth/device/code")) {
      return new Response(
        JSON.stringify({ device_code: "dev", user_code: "AAAA-BBBB", expires_in: 600, interval: 1 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "authorization_pending" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const err = await privateerOAuthProvider
      .login({ signal: controller.signal, onDeviceCode: () => controller.abort() })
      .then(() => null, (e: Error) => e);
    assert.ok(err, "login must reject when the signal is aborted, not hang");
    assert.equal(err!.message, "Login cancelled", "cancel message must match Pi's suppressed string exactly");
  } finally {
    globalThis.fetch = realFetch;
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
});

// Regression: the TUI had NO startup seed for the account credential. Pi only obtains
// one via /login, and our shutdown hook revokes the account session AND deletes its
// persisted auth.json entry — so a signed-in user who quit and relaunched landed on
// privateer/* with no key and hit "No API key found for privateer." on the first
// prompt, while the banner still read "connected". session_start must spawn a fresh
// session and store it as the provider's OAuth credential.
test("session_start seeds Pi's auth storage with a spawned account credential", async () => {
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  const realFetch = globalThis.fetch;
  saveCredentials({
    accessToken: "parent-access",
    refreshToken: "parent-refresh",
    user: { id: "u1" },
    serverBaseUrl: "https://stub.privateer.test",
  } as any);

  let spawns = 0;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.endsWith("/auth/session/spawn")) {
      spawns++;
      return new Response(JSON.stringify({ accessToken: "child-access", refreshToken: "child-refresh" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const handlers: Record<string, (e: unknown, ctx: unknown) => void> = {};
  const stored: { provider: string; cred: any }[] = [];
  const ctx = { modelRegistry: { authStorage: { set: (p: string, c: any) => stored.push({ provider: p, cred: c }) } } };

  try {
    makeAccountProvider()({
      registerProvider: () => {},
      on: (event: string, handler: (e: unknown, ctx: unknown) => void) => { handlers[event] = handler; },
    });
    assert.ok(handlers.session_start, "provider must subscribe to session_start");
    handlers.session_start!(undefined, ctx);
    // The handler is fire-and-forget; let the spawn settle.
    for (let i = 0; i < 20 && stored.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

    assert.equal(spawns, 1, "exactly one server-side session must be opened");
    assert.equal(stored[0].provider, "privateer");
    assert.equal(stored[0].cred.type, "oauth", "Pi resolves the key through the registered oauth provider");
    assert.equal(stored[0].cred.access, "child-access");

    // A second session_start (resume/fork/reload) must NOT open another device row.
    // Re-storing the SAME remembered credential is fine and deliberate — arming is
    // idempotent so a mid-session /login can call it too — but minting is not.
    handlers.session_start!(undefined, ctx);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(spawns, 1, "the session is minted once per process, not once per session_start");
    assert.ok(stored.every((s) => s.cred.access === "child-access"), "every arm uses the same session");
  } finally {
    globalThis.fetch = realFetch;
    clearCredentials();
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
});

// Regression: auth.json holds ONE `privateer` entry and is shared by every Privateer
// terminal on the machine, so the entry on disk belongs to whichever terminal armed
// last. The exit teardown used to remove it unconditionally — quitting one terminal
// deleted a live terminal's credential, which then worked from Pi's in-memory copy
// until `expires` and afterwards failed every prompt on "No API key found for
// privateer" with nothing to re-arm it. The drop must be ownership-checked.
test("exit teardown drops only the credential THIS process minted", () => {
  const live = { type: "oauth", access: "other-terminal", refresh: "other-r", expires: Date.now() + 3_600_000 };
  const s = fakeStore({ privateer: live });

  rememberAccountCredential({ access: "ours", refresh: "our-r", expires: Date.now() + 3_600_000 });
  assert.equal(dropPersistedAccountCredential(s.ctx), false, "another terminal's entry must not be removed");
  assert.deepEqual(s.data.privateer, live, "a live terminal's credential must survive our exit");

  // Same call, but now the persisted entry IS the one we minted.
  rememberAccountCredential({ access: "other-terminal", refresh: "other-r", expires: Date.now() + 3_600_000 });
  assert.equal(dropPersistedAccountCredential(s.ctx), true);
  assert.equal(s.data.privateer, undefined, "our own entry must be dropped, so the next launch spawns fresh");
});

// Sign-out and expiry revoke the machine's WHOLE token family, so the persisted entry
// is dead for every terminal — and clearCredentials() has already dropped the ownership
// memo by then, which an ownership-checked drop would read as "not ours".
test("forced teardown (sign-out / expiry) drops the entry with no ownership memo", () => {
  const s = fakeStore({ privateer: { type: "oauth", access: "whoever", refresh: "r", expires: 1 } });
  clearCredentials();
  assert.equal(ownedAccountCredential(), undefined, "clearCredentials must forget the armed credential");
  assert.equal(dropPersistedAccountCredential(s.ctx, { force: true }), true);
  assert.equal(s.data.privateer, undefined);
});

// Regression: rotating a refresh token that belongs to ANOTHER terminal takes over its
// session and invalidates the copy it still holds — the reuse hazard the child-session
// split exists to avoid. Pi hands us whatever auth.json currently holds, so refreshToken
// has to rotate ours regardless of what it was given.
test("refreshToken rotates OUR refresh token, never another terminal's", async () => {
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  const stub = stubServer();
  saveCredentials(PARENT);
  rememberAccountCredential({ access: "ours", refresh: "ours-refresh", expires: Date.now() + 1000 });
  try {
    const next = await privateerOAuthProvider.refreshToken({ refresh: "other-terminals-refresh" });
    assert.deepEqual(stub.seen.refreshed, ["ours-refresh"], "only our own token may be presented");
    assert.equal(next.access, "rotated-access");
    assert.equal(ownedAccountCredential()?.refresh, "rotated-refresh", "the rotation is now ours to track");
  } finally {
    stub.restore();
    clearCredentials();
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
});

// Regression: if the persisted entry disappears mid-session (another terminal's exit),
// Pi has no path back — getApiKey returns undefined and arming only ran at
// session_start. The turn boundary re-arms; an entry that merely EXPIRED is left to
// Pi's own refresh, which would otherwise mint a second session row.
test("ensureAccountArmed re-arms a missing entry and leaves an existing one to Pi", async () => {
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  const stub = stubServer();
  clearCredentials(); // also clears the armed memo, so this mints like a fresh process
  saveCredentials(PARENT);
  const s = fakeStore();
  try {
    await ensureAccountArmed(s.ctx);
    assert.equal(s.data.privateer?.access, "child-access", "a missing entry must be re-armed");
    assert.equal(s.data.privateer?.type, "oauth");
    assert.equal(stub.seen.spawns, 1);

    await ensureAccountArmed(s.ctx);
    assert.equal(stub.seen.spawns, 1, "an entry that exists is left alone");

    s.data.privateer.expires = Date.now() - 1;
    await ensureAccountArmed(s.ctx);
    assert.equal(stub.seen.spawns, 1, "an EXPIRED entry is Pi's refresh to do, not ours");
  } finally {
    stub.restore();
    clearCredentials();
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
});

// Regression: inference on the account channel goes out over Pi's own HTTP path, which
// has no reactive-401 hook (unlike authedFetch) — Pi refreshes on `expires` alone. A
// session revoked server-side therefore stayed dead for the remaining life of the access
// token (~24h), failing every prompt. Detecting the auth failure after the turn and
// replacing the session makes it one failed turn instead. Kept last: the cooldown it
// sets is process-wide.
test("an auth failure on the account channel replaces the session, once per cooldown", async () => {
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  const stub = stubServer();
  clearCredentials();
  saveCredentials(PARENT);
  const dead = { type: "oauth", access: "dead", refresh: "dead-r", expires: Date.now() + 3_600_000 };
  const s = fakeStore({ privateer: dead });
  rememberAccountCredential({ access: "dead", refresh: "dead-r", expires: Date.now() + 3_600_000 });
  try {
    assert.equal(
      await recoverAccountSession(s.ctx, "429 Too Many Requests"),
      false,
      "a throttle/cap is not an auth failure — replacing the session would not help",
    );
    assert.equal(s.data.privateer.access, "dead");

    assert.equal(await recoverAccountSession(s.ctx, '401 {"code":"SESSION_REVOKED"}'), true);
    assert.equal(s.data.privateer.access, "child-access", "the dead session must be replaced");

    assert.equal(
      await recoverAccountSession(s.ctx, "401 Authentication required"),
      false,
      "the cooldown must stop a retry storm when the account itself is gone",
    );
  } finally {
    stub.restore();
    clearCredentials();
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
});

// Regression: the server returns the device-code link scheme-less
// ("www.privateer.pro/settings/link-terminal?code=…"). Pi's login dialog renders it as
// an OSC-8 terminal hyperlink and our own widget prints it to be opened, and neither
// works without a scheme — the one link in the sign-in flow was dead text.
test("the device-code verification link is absolute", () => {
  assert.equal(
    verificationLink("www.privateer.pro/settings/link-terminal?code=DYNM-PJED"),
    "https://www.privateer.pro/settings/link-terminal?code=DYNM-PJED",
  );
  assert.equal(verificationLink("https://privateer.pro/x"), "https://privateer.pro/x", "already absolute: untouched");
  assert.equal(verificationLink("http://localhost:3000/x"), "http://localhost:3000/x", "dev http: untouched");
  assert.equal(verificationLink("  privateer.pro/x  "), "https://privateer.pro/x", "trimmed");
  assert.equal(verificationLink(undefined), "", "no link → nothing to render");
  assert.equal(verificationLink(""), "");
  // A scheme we don't expect is treated as a host, never handed to a terminal as a
  // clickable target of that scheme.
  assert.equal(verificationLink("javascript:alert(1)"), "https://javascript:alert(1)");
});

// Regression: login() short-circuited on hasCredentials(), so choosing "Privateer
// account" from Pi's /login while already linked silently re-armed the SAME account and
// reported success — switching accounts was unreachable from that flow. Pi passes an
// onSelect callback for this kind of branch; "keep" must not run a device flow, and
// "switch" must sign this machine out first and then run one.
test("login() offers to switch accounts when the machine is already linked", async () => {
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  const real = globalThis.fetch;
  let deviceCodes = 0;
  let spawns = 0;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.endsWith("/auth/device/code")) {
      deviceCodes++;
      return json({ device_code: "dev", user_code: "AAAA-BBBB", expires_in: 600, interval: 1 });
    }
    if (url.endsWith("/auth/device/token")) {
      return json({
        accessToken: "new-parent-access",
        refreshToken: "new-parent-refresh",
        user: { id: "u2", email: "second@example.com" },
      });
    }
    if (url.endsWith("/auth/session/spawn")) {
      spawns++;
      return json({ accessToken: "child-access", refreshToken: "child-refresh" });
    }
    return json({});
  }) as typeof fetch;

  try {
    // "keep": no device flow, and we stay on the account we were already signed in as.
    clearCredentials();
    saveCredentials(PARENT);
    const asked: string[] = [];
    await privateerOAuthProvider.login({
      onSelect: async (prompt) => {
        asked.push(prompt.message);
        return "keep";
      },
    });
    assert.match(asked[0], /Already signed in/, "the user must be asked, not silently re-armed");
    assert.equal(deviceCodes, 0, "staying signed in must not run a device flow");

    // "switch": signs the machine out, then runs the device flow for the new account.
    clearCredentials();
    saveCredentials(PARENT);
    await privateerOAuthProvider.login({ onSelect: async () => "switch" });
    assert.equal(deviceCodes, 1, "switching must run a fresh device login");
    assert.equal(currentUser()?.email, "second@example.com", "the new account is the signed-in one");

    // Dismissing the selector cancels quietly (Pi suppresses exactly "Login cancelled").
    clearCredentials();
    saveCredentials(PARENT);
    const err = await privateerOAuthProvider
      .login({ onSelect: async () => undefined })
      .then(() => null, (e: Error) => e);
    assert.equal(err?.message, "Login cancelled");

    // A host with no onSelect (older Pi, our own /signin) keeps the old behaviour.
    const before = deviceCodes;
    await privateerOAuthProvider.login({});
    assert.equal(deviceCodes, before, "no selector available → re-arm the linked account");
    assert.ok(spawns > 0, "every successful path arms the account channel");
  } finally {
    globalThis.fetch = real;
    clearCredentials();
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
});

// ── Catalog cache ────────────────────────────────────────────────────────────
//
// Its own PRIVATEER_HOME: the tests above register the provider, which kicks off a
// fire-and-forget catalog fetch against the real server, and that fetch would otherwise
// land in the middle of these and rewrite the file under them.
const CACHE_HOME = "/private/tmp/claude-501/pv-account-test-cache";
const CACHE_FILE = join(CACHE_HOME, "account-models.json");

async function withCacheHome(fn: () => Promise<void> | void): Promise<void> {
  const prevHome = process.env.PRIVATEER_HOME;
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_HOME = CACHE_HOME;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  rmSync(CACHE_HOME, { recursive: true, force: true });
  try {
    await fn();
  } finally {
    process.env.PRIVATEER_HOME = prevHome;
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
}

// Regression: a registerProvider call made AFTER extension load doesn't reach the model
// registry until the session binds (pi queues it), and everything that resolves a model at
// LAUNCH — Pi's saved-settings default and its session-model restore — runs before that.
// So only the synchronous seed existed, and any other account model was un-resolvable:
// findInitialModel fell through to "first model with configured auth", measurably an
// `openrouter/*` model on a machine with an OpenRouter key. Caching the live ids and
// seeding from them makes the launch-time lookup succeed.
test("a live catalog fetch is cached, and seeds the next launch synchronously", async () => {
  await withCacheHome(async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      json({
        models: [
          { modelId: "tinfoil/glm-5-2", privacy: { tier: "tee-unverified" } },
          { modelId: "allenai/olmo-3-32b-think", privacy: { tier: "zdr-enforced" } },
          { modelId: "amazon/nova-2-lite-v1", privacy: { tier: "zdr-enforced" } },
        ],
      })) as typeof fetch;
    try {
      const infos = await fetchAccountCatalog();
      assert.equal(infos.length, 3);
      assert.deepEqual(loadCachedCatalogIds(), [
        "tinfoil/glm-5-2",
        "allenai/olmo-3-32b-think",
        "amazon/nova-2-lite-v1",
      ]);

      const seeded = seedCatalogIds();
      assert.equal(seeded[0], "tinfoil/glm-5-2", "the account default must stay first: Pi clones models[0] for a custom id");
      assert.equal(new Set(seeded).size, seeded.length, "no duplicates between the seed list and the cache");
      for (const id of ["allenai/olmo-3-32b-think", "amazon/nova-2-lite-v1"]) {
        assert.ok(seeded.includes(id), `${id} must be resolvable at launch`);
      }

      // The registration that happens synchronously at load carries them.
      const calls: any[] = [];
      makeAccountProvider()({ registerProvider: (_n: string, cfg: unknown) => calls.push(cfg) });
      const ids = calls[0].models.map((m: any) => m.id);
      assert.ok(ids.includes("allenai/olmo-3-32b-think"), "the first, synchronous registration must include cached models");
    } finally {
      globalThis.fetch = real;
    }
  });
});

test("the fallback catalog is never cached, and a corrupt cache is ignored", async () => {
  await withCacheHome(async () => {
    const real = globalThis.fetch;
    // The seed list with NO cache present (withCacheHome just cleared it), so the
    // corrupt-cache assertion below doesn't hardcode DEFAULT_MODELS.
    const pureSeed = seedCatalogIds();
    try {
      // Seed a good cache the way a successful launch would.
      globalThis.fetch = (async () => json({ models: [{ modelId: "keep/me" }] })) as typeof fetch;
      await fetchAccountCatalog();
      assert.deepEqual(loadCachedCatalogIds(), ["keep/me"]);

      // Server down → we fall back to DEFAULT_MODELS, but must NOT write those six ids
      // over the cache: read back later they would masquerade as the real catalog.
      globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
      const infos = await fetchAccountCatalog();
      assert.ok(infos.length > 0 && infos.some((i) => i.id === "tinfoil/glm-5-2"), "fallback still yields a usable list");
      assert.deepEqual(loadCachedCatalogIds(), ["keep/me"], "a failed fetch must leave the cache alone");

      // Garbage on disk must not throw or register nonsense.
      writeFileSync(CACHE_FILE, "{not json", "utf8");
      assert.deepEqual(loadCachedCatalogIds(), []);
      assert.deepEqual(seedCatalogIds(), pureSeed, "a corrupt cache degrades to the seed list");
    } finally {
      globalThis.fetch = real;
    }
  });
});

test.after(() => {
  rmSync("/private/tmp/claude-501/pv-account-test", { recursive: true, force: true });
  rmSync(CACHE_HOME, { recursive: true, force: true });
});
