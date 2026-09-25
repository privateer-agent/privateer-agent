// PRIVATEER_HOME must point somewhere disposable before the auth module resolves
// paths (globalDir reads it lazily, so setting it here is enough).
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-account-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { streamSimple } from "@earendil-works/pi-ai/compat";
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
  recoverAccountConnection,
  rememberAccountCredential,
  verificationLink,
  accountProviderConfig,
  thinkingProfile,
} from "../src/providers/account.ts";
import { ensureSealedShim, sealedShimBase, stopSealedShim } from "../src/providers/sealedShim.ts";
import { ACCOUNT_DEFAULT_MODEL_ID } from "../src/providers/defaultModel.ts";
import { clearCredentials, currentUser, saveCredentials } from "../src/auth/privateer.ts";
import { setPiAuthStoreForTests } from "../src/providers/piAuthStore.ts";
import { isHardHttpFailure } from "../src/engine/errors.ts";

// A stand-in for Pi's ExtensionContext + auth store (auth.json), so the tests can see
// exactly which provider entries a teardown or an arm touched.
// pi 0.84 removed ctx.modelRegistry.authStorage and made the credential store async
// (read/modify/delete). The store is resolved internally now, so the fake is INSTALLED
// rather than passed in — same data, same assertions, one seam instead of a ctx shape.
function fakeStore(initial?: Record<string, unknown>) {
  const data: Record<string, any> = { ...(initial ?? {}) };
  setPiAuthStoreForTests({
    read: async (p: string) => data[p],
    modify: async (p: string, fn: (cur: unknown) => Promise<unknown>) => {
      const next = await fn(data[p]);
      if (next !== undefined) data[p] = next;
      return data[p];
    },
    delete: async (p: string) => {
      delete data[p];
    },
  });
  return { data, ctx: { hasUI: false } };
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

test("message_end gives signed-in account balance failures a durable top-up message", () => {
  clearCredentials();
  const handlers: Record<string, (e: unknown, ctx: unknown) => unknown> = {};
  makeAccountProvider()({
    registerProvider: () => {},
    on: (event, handler) => { handlers[event] = handler; },
  });
  const message = {
    role: "assistant", provider: "privateer", stopReason: "error", content: [],
    errorMessage: '429 {"code":"INSUFFICIENT_FUNDS","message":"Insufficient credits."}',
  };
  const ctx = { model: { provider: "privateer" } };
  const handle = (msg = message) => handlers.message_end({ message: msg }, ctx) as { message: typeof message } | undefined;
  try {
    assert.equal(handle(), undefined, "signed-out errors are untouched");
    saveCredentials(PARENT);
    const replacement = handle();
    assert.ok(replacement, "return a replacement for Pi's render/persist path, not just a toast");
    assert.equal(replacement.message.role, "assistant");
    assert.equal(replacement.message.stopReason, "error");
    assert.equal(replacement.message.content, message.content);
    assert.match(replacement.message.errorMessage, /insufficient balance/);
    assert.match(replacement.message.errorMessage, /https:\/\/privateer\.pro\/top-up/);
    assert.equal(isHardHttpFailure(replacement.message.errorMessage), true, "no session retry or compaction");
    assert.match(message.errorMessage, /^429 /, "leave replacement application to Pi");

    assert.equal(handle({ ...message, provider: "openrouter" }), undefined, "BYO provider billing is not Privateer billing");
    assert.equal(handle({ ...message, errorMessage: "429 Too Many Requests" }), undefined);
    assert.equal(handle({ ...message, errorMessage: '429 {"code":"DAILY_CAP_HIT"}' }), undefined);
    assert.equal(handle({ ...message, stopReason: "stop" }), undefined);
    assert.equal(handle({ ...message, role: "toolResult" }), undefined);
  } finally {
    clearCredentials();
  }
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
  // pi 0.84: the arm writes through the store's async `modify` rather than a ctx-borne
  // authStorage.set, so record every write there instead. The assertions below — one
  // write per arm, same credential each time — are unchanged.
  setPiAuthStoreForTests({
    read: async () => undefined,
    modify: async (provider: string, fn: (cur: unknown) => Promise<unknown>) => {
      const cred = await fn(undefined);
      stored.push({ provider, cred });
      return cred;
    },
    delete: async () => {},
  });
  const ctx = { hasUI: false };

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
test("exit teardown drops only the credential THIS process minted", async () => {
  const live = { type: "oauth", access: "other-terminal", refresh: "other-r", expires: Date.now() + 3_600_000 };
  const s = fakeStore({ privateer: live });

  rememberAccountCredential({ access: "ours", refresh: "our-r", expires: Date.now() + 3_600_000 });
  assert.equal(await dropPersistedAccountCredential(), false, "another terminal's entry must not be removed");
  assert.deepEqual(s.data.privateer, live, "a live terminal's credential must survive our exit");

  // Same call, but now the persisted entry IS the one we minted.
  rememberAccountCredential({ access: "other-terminal", refresh: "other-r", expires: Date.now() + 3_600_000 });
  assert.equal(await dropPersistedAccountCredential(), true);
  assert.equal(s.data.privateer, undefined, "our own entry must be dropped, so the next launch spawns fresh");
});

// Sign-out and expiry revoke the machine's WHOLE token family, so the persisted entry
// is dead for every terminal — and clearCredentials() has already dropped the ownership
// memo by then, which an ownership-checked drop would read as "not ours".
test("forced teardown (sign-out / expiry) drops the entry with no ownership memo", async () => {
  const s = fakeStore({ privateer: { type: "oauth", access: "whoever", refresh: "r", expires: 1 } });
  clearCredentials();
  assert.equal(ownedAccountCredential(), undefined, "clearCredentials must forget the armed credential");
  assert.equal(await dropPersistedAccountCredential({ force: true }), true);
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
      assert.equal(
        seeded[0],
        ACCOUNT_DEFAULT_MODEL_ID,
        "the account default must stay first: Pi clones models[0] for a custom id",
      );
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
      assert.ok(
        infos.length > 0 && infos.some((i) => i.id === ACCOUNT_DEFAULT_MODEL_ID),
        "fallback still yields a usable list",
      );
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

// `phala/*` is sealed-only: the server's cleartext /api/agent/v1 has no Phala route and
// rejects the id ("phala/… is not a valid model ID"), yet /api/models advertises the
// models to every client. With sealed mode off they were pickable and then failed on the
// first prompt. Verified live 2026-07-31.
async function withSealed(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.PRIVATEER_SEALED;
  if (value === undefined) delete process.env.PRIVATEER_SEALED;
  else process.env.PRIVATEER_SEALED = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_SEALED;
    else process.env.PRIVATEER_SEALED = prev;
  }
}

const CATALOG_WITH_PHALA = {
  models: [
    { modelId: "tinfoil/glm-5-2", privacy: { tier: "tee-unverified" } },
    { modelId: "phala/qwen/qwen-2.5-7b-instruct", privacy: { tier: "tee-unverified" } },
    { modelId: "amazon/nova-2-lite-v1", privacy: { tier: "zdr-enforced" } },
  ],
};

const registeredIds = (cfg: any): string[] => cfg.models.map((m: any) => m.id);

test("sealed-only phala models are not registered when sealed mode is off", async () => {
  await withCacheHome(async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => json(CATALOG_WITH_PHALA)) as typeof fetch;
    try {
      await withSealed("0", async () => {
        // The catalog and the cache stay the SERVER's list — they record what is on
        // offer, not what this process can reach.
        const infos = await fetchAccountCatalog();
        assert.ok(infos.some((i) => i.id === "phala/qwen/qwen-2.5-7b-instruct"));
        assert.ok(loadCachedCatalogIds().includes("phala/qwen/qwen-2.5-7b-instruct"));

        // Servability is decided at registration, and nothing phala-shaped survives it.
        const ids = registeredIds(accountProviderConfig(infos.map((i) => i.id)));
        assert.ok(!ids.some((id) => id.startsWith("phala/")), "no unservable model may be registered");
        // tinfoil/* is NOT sealed-only: the cleartext path serves it (sealed mode only
        // upgrades the badge), so it must survive.
        assert.ok(ids.includes("tinfoil/glm-5-2"));
      });
    } finally {
      globalThis.fetch = real;
    }
  });
});

test("sealed mode alone doesn't re-offer phala — the shim has to be listening", async () => {
  // The flag says we intend to seal; the shim is what phala/*'s baseUrl points at.
  // "Enabled but the shim failed to bind" must not put back models that would 400.
  await withSealed("1", async () => {
    // Earlier tests call makeAccountProvider, which now starts the shim (sealed is on
    // by default) — so drop it explicitly to reach the state we're asserting about.
    await stopSealedShim();
    assert.equal(sealedShimBase(), null);
    const ids = registeredIds(accountProviderConfig(["tinfoil/glm-5-2", "phala/x/y"]));
    assert.deepEqual(ids, ["tinfoil/glm-5-2"]);
  });
});

test("phala models are registered once the shim is up", async () => {
  await withSealed("1", async () => {
    const shim = await ensureSealedShim();
    assert.ok(shim.startsWith("http://127.0.0.1:"));
    try {
      const ids = registeredIds(accountProviderConfig(["tinfoil/glm-5-2", "phala/x/y"]));
      assert.ok(ids.includes("phala/x/y"), "with the shim listening phala/* IS servable");
      // …and it routes through the shim, not the cleartext proxy.
      const entry: any = (accountProviderConfig(["phala/x/y"]) as any).models[0];
      assert.equal(entry.baseUrl, `${shim}/phala/v1`);
    } finally {
      await stopSealedShim();
    }
  });
});

test("a phala-only catalog still leaves the user a usable model list", async () => {
  await withCacheHome(async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => json({ models: [{ modelId: "phala/only/model" }] })) as typeof fetch;
    try {
      await withSealed("0", async () => {
        await fetchAccountCatalog();
        // seedCatalogIds always leads with DEFAULT_MODELS, so filtering every live id
        // out can never leave an empty picker.
        const ids = registeredIds(accountProviderConfig(seedCatalogIds()));
        assert.ok(ids.length > 0);
        assert.ok(!ids.some((id) => id.startsWith("phala/")));
      });
    } finally {
      globalThis.fetch = real;
    }
  });
});

// ── Thinking control ─────────────────────────────────────────────────────────

test("enclave thinking models are registered as steerable, in their verified shape", () => {
  // The GLM/Qwen chat-template family: pi's "qwen-chat-template" emits the
  // `chat_template_kwargs.enable_thinking` the enclave actually honours.
  for (const id of [
    "tinfoil/glm-5-2",
    "near/zai-org/GLM-5.1-FP8",
    "near/Qwen/Qwen3.6-35B-A3B-FP8",
    "phala/z-ai/glm-5.2",
  ]) {
    const p = thinkingProfile(id);
    assert.ok(p, `${id} must be steerable`);
    assert.equal(p.reasoning, true);
    assert.equal(p.compat?.thinkingFormat, "qwen-chat-template");
    // Binary switch → exactly two levels offered, not five that all mean "on".
    assert.equal(p.thinkingLevelMap?.low, null);
  }

  // gpt-oss is the other shape: reasoning_effort, which is pi's DEFAULT format for
  // our baseUrl — so a compat override here would actively break it.
  const oss = thinkingProfile("tinfoil/gpt-oss-120b");
  assert.ok(oss);
  assert.equal(oss.compat, undefined);
  assert.equal(oss.thinkingLevelMap?.off, "low");
});

test("models whose thinking shape we did not verify are left exactly as they were", () => {
  // Reasons, but ignored both levers when probed — a dial connected to nothing.
  assert.equal(thinkingProfile("tinfoil/kimi-k2-6"), null);
  // Non-thinking variants.
  assert.equal(thinkingProfile("phala/qwen/qwen-2.5-7b-instruct"), null);
  assert.equal(thinkingProfile("tinfoil/llama3-3-70b"), null);

  // Proxied families that DO reason but whose parameter shape is unprobed from here.
  // An unsupported parameter fails the whole turn, and proxyChatCompletion is the one
  // relay path with no retry-without-the-hint fallback — so they stay unannotated.
  for (const id of ["anthropic/claude-sonnet-5", "qwen/qwen3-next-80b-a3b-thinking", "moonshotai/kimi-k3", "minimax/minimax-m3"]) {
    assert.equal(thinkingProfile(id), null, `${id} must not be annotated`);
  }

  // Proxied models that do not reason at all — the catalog is 284 ids wide and
  // carries roleplay finetunes and code-apply models alongside the frontier ones.
  for (const id of ["google/gemma-4-31b-it", "openai/gpt-4o", "openai/gpt-3.5-turbo-16k", "sao10k/l3-euryale-70b", "morph/morph-v3-large", "deepseek/deepseek-chat-v3-0324", "x-ai/grok-build-0.1"]) {
    assert.equal(thinkingProfile(id), null, `${id} must not be annotated`);
  }
});

test("the proxied families that burned their budget now carry an OpenRouter effort dial", () => {
  // These are the exact ids measured spending 58–76% of every output token on
  // reasoning — uncapped, because `reasoning: false` sends no thinking parameter at
  // all and reasoning shares maxTokens with the answer.
  for (const id of [
    "google/gemini-3.7-flash",
    "google/gemini-3.8-flash",
    "z-ai/glm-5.3-flash",
    "deepseek/deepseek-v4.1-flash",
    "x-ai/grok-4.6",
    "openai/gpt-6-astra",
  ]) {
    const p = thinkingProfile(id);
    assert.ok(p, `${id} must be steerable`);
    assert.equal(p.reasoning, true);
    // OpenRouter's nested `reasoning` object — the one shape the relay forwards
    // unchanged, and the one that also caps the thinking budget.
    assert.equal(p.compat?.thinkingFormat, "openrouter");
    // "off" is the floor, not silence: `effort: "none"` is not universally accepted
    // and a rejected enum costs the whole turn.
    assert.equal(p.thinkingLevelMap?.off, "low");
    assert.equal(p.thinkingLevelMap?.minimal, "low");
    // low/medium/high pass through verbatim; xhigh/max stay unmapped so pi-ai's
    // getSupportedThinkingLevels drops them rather than inventing a level.
    assert.equal(p.thinkingLevelMap?.high, undefined);
    assert.equal(p.thinkingLevelMap?.xhigh, undefined);
  }
});

test("the thinking profile is a fresh copy per model", () => {
  // These land on ~82 registered entries; one shared nested object is a single
  // careless mutation away from retuning the whole catalog.
  const a = thinkingProfile("google/gemini-3.8-flash")!;
  const b = thinkingProfile("z-ai/glm-5.3-flash")!;
  assert.notEqual(a.thinkingLevelMap, b.thinkingLevelMap);
  assert.notEqual(a.compat, b.compat);
  a.thinkingLevelMap!.off = "high";
  assert.equal(thinkingProfile("z-ai/glm-5.3-flash")?.thinkingLevelMap?.off, "low");
});

// What actually goes on the wire. The profile object is only a promise about the
// request body, and the body is the thing the relay forwards verbatim to OpenRouter —
// so pin it end to end rather than trusting the shape. A capture server stands in for
// the relay: pi-ai builds the request from our registered model entry, we read it back.
async function captureRequestBody(
  id: string,
  // Pi's thinking LEVEL (streamSimple clamps it to the model's supported set and
  // then maps it through thinkingLevelMap); "off" is what these models sit at today.
  reasoning: string,
): Promise<Record<string, any>> {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ delta: { content: "hi" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "x", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const cfg: any = accountProviderConfig([id]);
    const entry = cfg.models.find((m: any) => m.id === id);
    const model = { ...entry, api: cfg.api, provider: "privateer", baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1` };
    const context = { systemPrompt: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }] };
    await (await streamSimple(model as any, context as any, { apiKey: "k", maxTokens: entry.maxTokens, reasoning } as any)).result();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  return bodies[0] ?? {};
}

test("a proxied thinking model sends OpenRouter's nested reasoning object", async () => {
  // "off" is the level these models sit at today (with reasoning:false pi offers no
  // other), and it is the one that has to stop costing a whole budget: it must send a
  // real floor, not nothing. Nothing is what produced the 16,384-token think.
  const off = await captureRequestBody("google/gemini-3.8-flash", "off");
  assert.deepEqual(off.reasoning, { effort: "low" });
  // Never both spellings — OpenRouter reads the nested object, and a request carrying
  // the flat field too is one more thing a provider can reject.
  assert.equal(off.reasoning_effort, undefined);
  // The ceiling the effort is a fraction of. Which spelling carries it is pi's
  // baseUrl-derived choice (compat.maxTokensField), not ours, and the relay honours
  // either — proxyRequestBounds reads max_completion_tokens first, then max_tokens.
  assert.equal(off.max_completion_tokens ?? off.max_tokens, 16384);

  // The dial actually moves.
  const medium = await captureRequestBody("google/gemini-3.8-flash", "medium");
  assert.deepEqual(medium.reasoning, { effort: "medium" });
  const high = await captureRequestBody("openai/gpt-6-astra", "high");
  assert.deepEqual(high.reasoning, { effort: "high" });
});

test("an unannotated model still sends no thinking parameter at all", async () => {
  // The safety property: families we have not probed must keep the exact body they
  // had, because a rejected parameter costs the whole turn and proxyChatCompletion
  // has no retry-without-the-hint fallback.
  const body = await captureRequestBody("anthropic/claude-sonnet-5", "off");
  assert.equal(body.reasoning, undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking, undefined);
  assert.equal(body.chat_template_kwargs, undefined);
});

test("a published context window reaches the model entry, and survives a relaunch", async () => {
  // WHY: pi sizes each turn's answer budget as (contextWindow − prompt − 4096) and
  // clamps max_tokens to it. Registering every model at a flat 128000 therefore
  // throttled a larger-windowed model — and, before the pi-ai floor patch, collapsed
  // its answer to a single token — while the model still had room.
  await withCacheHome(async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      json({
        models: [
          { modelId: "google/gemini-3.8-flash", privacy: { tier: "zdr-enforced" }, contextLength: 1048576 },
          // Upstream has no window for this one — the server says so honestly.
          { modelId: "acme/no-window", privacy: { tier: "zdr-enforced" }, contextLength: null },
          // An older server, before the field existed: the key is simply absent.
          { modelId: "acme/old-server", privacy: { tier: "zdr-enforced" } },
          // Not credible — a garbled or hostile number must never reach pi's budget
          // arithmetic, where too small silently strangles every turn.
          { modelId: "acme/absurd", privacy: { tier: "zdr-enforced" }, contextLength: 12 },
          { modelId: "acme/hostile", privacy: { tier: "zdr-enforced" }, contextLength: 9e99 },
        ],
      })) as typeof fetch;
    try {
      const infos = await fetchAccountCatalog();
      assert.equal(infos.find((i) => i.id === "google/gemini-3.8-flash")?.contextWindow, 1048576);
      for (const id of ["acme/no-window", "acme/old-server", "acme/absurd", "acme/hostile"]) {
        assert.equal(infos.find((i) => i.id === id)?.contextWindow, undefined, `${id} must read as unknown`);
      }

      const entry = (id: string) =>
        (accountProviderConfig([id]) as any).models.find((m: any) => m.id === id);
      assert.equal(entry("google/gemini-3.8-flash").contextWindow, 1048576);
      // Unknown keeps the documented fallback — an older server behaves as it always did.
      for (const id of ["acme/no-window", "acme/old-server", "acme/absurd", "acme/hostile"]) {
        assert.equal(entry(id).contextWindow, 128000, `${id} must fall back`);
      }
    } finally {
      globalThis.fetch = real;
    }

    // THE LAUNCH CASE. Registration is synchronous and runs before any fetch can
    // resolve, so a window known only to the live catalog would always arrive one
    // launch too late. Simulate the next launch: fresh module state, no network.
    const cached = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    assert.equal(cached.windows["google/gemini-3.8-flash"], 1048576);
    assert.equal("acme/no-window" in cached.windows, false, "unknown windows are not persisted as guesses");
    // v1 readers still find what they expect.
    assert.deepEqual(cached.ids.slice(0, 2), ["google/gemini-3.8-flash", "acme/no-window"]);

    const fresh = await import(`../src/providers/account.ts?relaunch=${Date.now()}`);
    assert.equal(fresh.accountContextWindow("google/gemini-3.8-flash"), 1048576);
    assert.equal(
      fresh.accountProviderConfig(["google/gemini-3.8-flash"]).models[0].contextWindow,
      1048576,
      "the window must be on the entry pi binds at launch, not only after the fetch",
    );
  });
});

test("a v1 cache with no windows still launches, on the fallback", async () => {
  // The upgrade path: a file written by a build that predates this field.
  await withCacheHome(async () => {
    mkdirSync(CACHE_HOME, { recursive: true });
    writeFileSync(
      CACHE_FILE,
      JSON.stringify({ v: 1, fetchedAt: new Date().toISOString(), ids: ["google/gemini-3.8-flash"] }),
      "utf8",
    );
    const fresh = await import(`../src/providers/account.ts?v1cache=${Date.now()}`);
    assert.equal(fresh.accountContextWindow("google/gemini-3.8-flash"), undefined);
    assert.equal(fresh.accountProviderConfig(["google/gemini-3.8-flash"]).models[0].contextWindow, 128000);
    assert.deepEqual(fresh.loadCachedCatalogIds(), ["google/gemini-3.8-flash"]);
  });
});

test("the registered model entries carry the profile through to pi", () => {
  const models: any[] = (accountProviderConfig(["tinfoil/glm-5-2", "google/gemini-3.8-flash", "anthropic/claude-sonnet-5"]) as any).models;
  const glm = models.find((m) => m.id === "tinfoil/glm-5-2");
  const gemini = models.find((m) => m.id === "google/gemini-3.8-flash");
  const claude = models.find((m) => m.id === "anthropic/claude-sonnet-5");
  // pi gates every thinking branch on this field; false is what pinned the catalog
  // to maximum thinking with an inert toggle.
  assert.equal(glm.reasoning, true);
  assert.equal(glm.compat.thinkingFormat, "qwen-chat-template");
  // The proxied path reaches the registry too — this is what stops the relay's
  // models from reasoning until the answer has nowhere left to go.
  assert.equal(gemini.reasoning, true);
  assert.equal(gemini.compat.thinkingFormat, "openrouter");
  assert.equal(claude.reasoning, false);
  assert.equal(claude.compat, undefined);
});

test.after(() => {
  rmSync("/private/tmp/claude-501/pv-account-test", { recursive: true, force: true });
  rmSync(CACHE_HOME, { recursive: true, force: true });
});

// Regression: a session started while a sign-in was failing answered "Connection error."
// on every message, while a fresh `privateer` worked. A request with no HTTP response
// has no 401 to key recovery on, so recoverAccountConnection asks the server about the
// token itself — and only replaces the session when the server actually refuses it.
test("a connection failure renews a refused session, and leaves a live one alone", async () => {
  const prevUrl = process.env.PRIVATEER_SERVER_URL;
  process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
  const stub = stubServer();
  clearCredentials();
  saveCredentials(PARENT);
  const slot = (globalThis as any)[Symbol.for("privateer.accountCredential")];
  const held = { access: "stale", refresh: "stale-r", expires: Date.now() + 3_600_000 };
  const s = fakeStore({ privateer: { type: "oauth", ...held } });
  rememberAccountCredential(held);
  let reRegistered = 0;
  try {
    delete slot.connectionRecoveredAt;
    // No answer from the server: a real outage. Replacing the session would only leak a row.
    const offline = await recoverAccountConnection(s.ctx, "near/some-model", () => reRegistered++, async () => null);
    assert.deepEqual(offline, { shim: false, session: false });
    assert.equal(s.data.privateer.access, "stale");
    assert.equal(reRegistered, 0, "a non-sealed model has no shim to restart");

    // Within the cooldown, nothing is even probed.
    let probed = 0;
    await recoverAccountConnection(s.ctx, "near/some-model", () => {}, async () => (probed++, 401));
    assert.equal(probed, 0);

    // The server refuses the token: renew it, as a 401 would have.
    delete slot.connectionRecoveredAt;
    const refused = await recoverAccountConnection(s.ctx, "near/some-model", () => {}, async (access) => (access === "stale" ? 401 : 200));
    assert.deepEqual(refused, { shim: false, session: true });
    assert.equal(s.data.privateer.access, "child-access");
  } finally {
    stub.restore();
    clearCredentials();
    if (prevUrl === undefined) delete process.env.PRIVATEER_SERVER_URL;
    else process.env.PRIVATEER_SERVER_URL = prevUrl;
  }
});
