/**
 * Privateer account login for the agent CLI.
 *
 * Instead of a provider API key, the terminal logs into the user's Privateer
 * account and runs inference billed to that account. Auth uses the device
 * authorization grant (RFC 8628): the CLI shows a short user_code, the user
 * approves it inside the already-logged-in Privateer mobile/web app, and the
 * server mints a CLI-scoped session here. This works identically for email and
 * wallet accounts — the wallet/password signing all happens in the app, never
 * in the terminal.
 *
 * Framework-agnostic on purpose: the Ink UI drives `runDeviceLogin` and the
 * provider factory uses `authedFetch`; nothing here imports React.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { globalDir, credentialsPath } from "../config/paths.ts";
import {
  type OwnedSession,
  recordOwnedSession,
  forgetOwnedSession,
  orphanedSessions,
  dropOwnedSession,
  clearOwnedSessions,
} from "./accountSessions.ts";
import { isAccountCapCode } from "../engine/errors.ts";
import { terminalPublicKeyBase64 } from "../crypto/terminalKey.ts";
import { pinAccountSignKey, clearAccountSignKey } from "../crypto/accountTrust.ts";

// Default Privateer API host. NOTE: this is still the legacy "helix" Render
// hostname the mobile/web client also points at (client/config/environment.ts);
// centralize/rename later. Override with PRIVATEER_SERVER_URL for dev/self-host.
export const DEFAULT_SERVER_URL = "https://helix-server-m1ac.onrender.com";

export interface PrivateerUser {
  id: string;
  email: string | null;
  solanaPublicKey: string | null;
  kekSource: string | null;
}

export interface Credentials {
  accessToken: string;
  refreshToken: string;
  user: PrivateerUser;
  serverBaseUrl: string;
}

// A server URL is safe only if it's https, OR http to a loopback host (dev).
// Anything else (plain http to a remote host) would send the account bearer
// token in cleartext and is rejected — a poisoned PRIVATEER_SERVER_URL must not
// be able to redirect/downgrade the connection and exfiltrate the token.
export function isSafeServerUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1")) {
    return true;
  }
  return false;
}

// Resolved base URL: env override > stored (from a prior login) > default.
// Both the override and the stored value are validated — never fall through to
// an insecure host that could capture the session token.
export function serverBaseUrl(): string {
  const env = process.env.PRIVATEER_SERVER_URL?.replace(/\/$/, "");
  if (env) {
    if (!isSafeServerUrl(env)) {
      throw new Error(
        `Refusing PRIVATEER_SERVER_URL=${env}: must be https:// (http allowed only for localhost). ` +
          `This protects your account token from being sent over an insecure or attacker-controlled connection.`,
      );
    }
    return env;
  }
  const base = (loadCredentials()?.serverBaseUrl || DEFAULT_SERVER_URL).replace(/\/$/, "");
  if (!isSafeServerUrl(base)) {
    throw new Error(`Stored Privateer server URL is not https (${base}). Run /logout then /login again.`);
  }
  return base;
}

// A friendly default label so a linked session is recognizable in the app's
// "Linked terminals" list, e.g. "patrick@MacBook-Pro".
export function defaultDeviceLabel(): string {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    return "terminal";
  }
}

// ── Cross-instance state ─────────────────────────────────────────────────────
//
// Pi loads every extension with a FRESH jiti instance (`moduleCache: false`, see
// core/extensions/loader.js), so privateer-brand and privateer-account each get their
// OWN copy of this module — separate credential cache, separate listener sets.
//
// That silently broke /login. The account provider's OAuth login() ran inside the
// privateer-account copy and called notifySignedIn() there, while the UI's listener
// (the one that switches the live session onto a model the account can actually
// serve) was registered on the privateer-brand copy. The signal never crossed, so a
// successful sign-in left the terminal pinned to its keyless launch model and the
// very next prompt died with "No API key found for openrouter" — exactly the state
// the login was supposed to fix. The same split let a /logout in one copy leave a
// stale `user` memoized in another.
//
// So anything that must be observed ACROSS extensions lives on globalThis, keyed by
// a registered Symbol — one bus, however many module instances jiti creates.
const SHARED = Symbol.for("privateer.auth.shared");

interface SharedAuthState {
  cache: Credentials | null;
  signedIn: Set<SignedInListener>;
  expired: Set<SessionExpiredListener>;
}

function shared(): SharedAuthState {
  const g = globalThis as { [SHARED]?: SharedAuthState };
  return (g[SHARED] ??= { cache: null, signedIn: new Set(), expired: new Set() });
}

// ── Credential storage (0600, like saveGlobalConfig) ─────────────────────────

// Per-terminal child session (see spawnChildSession). Held in memory ONLY — it
// is never written to the shared credentials file, so each running terminal
// rotates its own refresh token in isolation.
interface ChildSession { accessToken: string; refreshToken: string; }
let _child: ChildSession | null = null;
let _spawnInFlight: Promise<ChildSession> | null = null;
let _refreshInFlight: Promise<ChildSession> | null = null;

// The most recent ACCOUNT-provider session (spawnAccountCredentials /
// refreshAccountCredentials). Pi owns this credential's lifecycle — it drives the
// account inference channel in the TUI — so it's a distinct server-side session
// (device row) from _child. We record only its latest access token here so exit
// cleanup / an explicit sign-out (revokeAccountSession) can kill it. Rotations
// overwrite it; the previous token is already dead server-side, so tracking only
// the latest is right.
//
// LIFECYCLE HAZARD: Pi PERSISTS this session to auth.json (with a ~24h `expires`) and
// reuses it on the next launch, refreshing only when `Date.now() >= expires` — it does
// NOT refresh reactively on a 401. So revoking it at exit while leaving the persisted
// copy in place would let the next run send a token that still looks valid but is dead
// server-side → inference fails with a dead-end `401 {code: SESSION_REVOKED}`.
// The fix is to revoke it AND drop the persisted credential together: the caller must
// remove the "privateer" entry from Pi's authStorage (authStorage.remove("privateer"))
// right after revokeLocalSessions() so the next launch spawns a fresh session instead
// of reusing the revoked one. Doing both is safe; doing only one is not. See
// revokeLocalSessions and its callers (cli/chat.ts, daemon/index.ts).
//
// That pairing only covers a CLEAN exit, though. A terminal killed without running its
// shutdown hook leaves its row alive server-side for the full TTL, and the next launch
// used to spawn another on top of it — enough repeats and the spawn is refused with
// `429 CHILD_SESSION_CAP`. So every session is also recorded in a pid-keyed registry
// (auth/accountSessions.ts) and acquireAccountCredential reclaims one whose owning
// terminal is gone instead of spawning. Keep the registry in step with reality:
// recordOwnedSession wherever a credential is minted or rotated, forgetOwnedSession
// wherever one is revoked.
let _account: { accessToken: string } | null = null;

export function loadCredentials(): Credentials | null {
  // Only a successfully-read credential is memoized. A NEGATIVE result (file absent
  // or unreadable) is deliberately NOT cached: the credential can appear mid-session
  // — the account /login writes credentials.json AFTER the extensions have already
  // booted, and under jiti each extension gets its OWN module instance of this file,
  // so a login's saveCredentials() never reaches another extension's `_cache`. If we
  // memoized the pre-login "absent" as null, that instance would report "not signed
  // in" forever (e.g. /remote-access refusing after a successful sign-in). Re-reading
  // disk on each miss lets a later call see what a sign-in just wrote.
  const state = shared();
  if (state.cache) return state.cache;
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  try {
    state.cache = JSON.parse(readFileSync(path, "utf8")) as Credentials;
  } catch {
    return null;
  }
  return state.cache;
}

export function saveCredentials(creds: Credentials): void {
  const dir = globalDir();
  mkdirSync(dir, { recursive: true });
  tryChmod(dir, 0o700);
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify(creds, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  tryChmod(path, 0o600);
  shared().cache = creds;
}

export function clearCredentials(): void {
  try {
    rmSync(credentialsPath(), { force: true });
  } catch {
    /* nothing to remove */
  }
  // Drop the pinned account signing key too — it belongs to the account that just
  // signed out; a different account must re-pin its own at link.
  clearAccountSignKey();
  shared().cache = null;
  _child = null;
  _account = null;
}

export function hasCredentials(): boolean {
  return loadCredentials() !== null;
}

export function currentUser(): PrivateerUser | null {
  return loadCredentials()?.user ?? null;
}

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* non-POSIX filesystem — best effort */
  }
}

// ── Session-expiry notification ──────────────────────────────────────────────
// Fired when the machine login is invalidated server-side: the parent refresh
// token's TTL lapsed (14 days for email logins, 60 for wallet — each session
// spawn slides it forward, so this means the machine sat unused that long), or
// it was revoked (from the app's Linked Devices, or by reuse detection).
// Without a listener the credentials are wiped silently and Privateer just
// stops working; the UI subscribes to announce the sign-out prominently.

type SessionExpiredListener = () => void;

export function onSessionExpired(listener: SessionExpiredListener): () => void {
  const listeners = shared().expired;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifySessionExpired(): void {
  for (const listener of shared().expired) {
    try {
      listener();
    } catch {
      /* a failing listener must not break the auth path */
    }
  }
}

// A server-pushed `session_revoked` relay frame arrived: the account signed this
// terminal out (from the app's Linked Devices). Treat it exactly like a lazily-
// detected expiry — wipe the local machine login and announce it via
// onSessionExpired — but PROMPTLY, while the process is live, instead of waiting
// for the next authedFetch/launch to hit a 401. The relay owner additionally
// drops remote access. No-op if we're already signed out, so a duplicate frame
// (or a frame racing an in-flight /signout) doesn't fire a spurious notice.
export function handleServerRevoke(): void {
  if (!hasCredentials()) return;
  clearCredentials();
  notifySessionExpired();
}

// ── Sign-in notification ─────────────────────────────────────────────────────
// Fired when a Privateer login completes on this terminal — the cue for the UI to
// re-render its header/badge to the signed-in state. It reaches every sign-in entry
// point:
//   - our dedicated /signin command and a FRESH /login → "Use a subscription" OAuth
//     login both run the device-code flow, which fires this from pollForToken once
//     credentials are written; and
//   - an ALREADY-LINKED machine selecting the subscription runs no device code (it
//     just spawns an account session), so privateerOAuthProvider.login() fires this
//     itself — otherwise that path had no hook back to the header and it kept showing
//     the stale "not signed in" banner until the next launch.
// A listener here refreshes the UI regardless of which path the user took.

type SignedInListener = () => void;

export function onSignedIn(listener: SignedInListener): () => void {
  const listeners = shared().signedIn;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Emit the sign-in signal. Exported so the account OAuth provider can announce a
// completed subscription login on the already-linked path (see the note above).
// Listeners MUST be idempotent: a device-code login fires this once the credentials
// land and again once the account channel is armed (see privateerOAuthProvider.login).
export function notifySignedIn(): void {
  for (const listener of shared().signedIn) {
    try {
      listener();
    } catch {
      /* a failing listener must not break the auth path */
    }
  }
}

// ── Device authorization flow ────────────────────────────────────────────────

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

async function postJson(base: string, path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  // Spread init FIRST so method/headers/body below stay authoritative — otherwise
  // a trailing `...init` clobbers the merged headers (dropping Content-Type when a
  // caller passes its own headers, e.g. Authorization on /auth/session/spawn).
  return fetch(`${base}${path}`, {
    ...init,
    method: "POST",
    headers: { "Content-Type": "application/json", ...((init.headers as Record<string, string>) || {}) },
    body: JSON.stringify(body),
  });
}

// Step 1: ask the server for a device + user code the human will approve in-app.
export async function requestDeviceCode(deviceLabel = defaultDeviceLabel()): Promise<DeviceCode> {
  const base = serverBaseUrl();
  // This terminal's public key rides the grant so the app can PIN it on approval
  // (TOFU) — the trust anchor for later sealing secrets (channel tokens) that only
  // this machine can open. Best-effort: if keygen fails we just omit it and the app
  // falls back to terminal-only secret entry rather than blocking login.
  let terminalPub: string | undefined;
  try {
    terminalPub = terminalPublicKeyBase64();
  } catch {
    /* no key → no app-sealed secrets for this terminal; login still proceeds */
  }
  const res = await postJson(base, "/auth/device/code", { deviceLabel, terminalPub });
  if (!res.ok) {
    throw new Error(`Couldn't start login (${res.status}). Check your connection or PRIVATEER_SERVER_URL.`);
  }
  return (await res.json()) as DeviceCode;
}

export type PollState = "pending" | "slow_down";

/**
 * Step 2: poll until the user approves in the app. Resolves with the saved
 * credentials, or rejects on denial/expiry. `onPoll` lets the UI show progress;
 * `signal` cancels the wait.
 */
export async function pollForToken(
  code: DeviceCode,
  opts: { onPoll?: (state: PollState) => void; signal?: AbortSignal } = {},
): Promise<Credentials> {
  const base = serverBaseUrl();
  let interval = Math.max(1, code.interval || 5) * 1000;
  const deadline = Date.now() + (code.expires_in || 600) * 1000;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("Login cancelled.");
    await sleep(interval, opts.signal);

    const res = await postJson(base, "/auth/device/token", { device_code: code.device_code });

    if (res.ok) {
      const data = (await res.json()) as Omit<Credentials, "serverBaseUrl"> & { accountSignPub?: string };
      const creds: Credentials = { accessToken: data.accessToken, refreshToken: data.refreshToken, user: data.user, serverBaseUrl: base };
      saveCredentials(creds);
      // Pin the account's signing public key (TOFU) so channel-config from the app can
      // be verified as genuinely coming from the account, not a forging relay (F7/F8).
      pinAccountSignKey(data.accountSignPub);
      notifySignedIn();
      return creds;
    }

    let err = "";
    try {
      err = ((await res.json()) as { error?: string }).error || "";
    } catch {
      /* non-JSON */
    }

    if (err === "authorization_pending") {
      opts.onPoll?.("pending");
    } else if (err === "slow_down") {
      interval += 2000; // back off per RFC 8628
      opts.onPoll?.("slow_down");
    } else if (err === "access_denied") {
      throw new Error("Login was denied in the app.");
    } else if (err === "expired_token") {
      throw new Error("This login code expired. Run /login again.");
    } else {
      throw new Error(`Login failed (${res.status}${err ? `: ${err}` : ""}).`);
    }
  }
  throw new Error("This login code expired. Run /login again.");
}

/**
 * High-level orchestration: request a code, surface it via `onCode`, then wait
 * for approval. Returns the logged-in user.
 */
export async function runDeviceLogin(opts: {
  deviceLabel?: string;
  onCode: (code: DeviceCode) => void;
  onPoll?: (state: PollState) => void;
  signal?: AbortSignal;
}): Promise<PrivateerUser> {
  const code = await requestDeviceCode(opts.deviceLabel);
  opts.onCode(code);
  const creds = await pollForToken(code, { onPoll: opts.onPoll, signal: opts.signal });
  return creds.user;
}

// ── Session token use + refresh ──────────────────────────────────────────────

/**
 * Spawn THIS terminal's own session from the machine login (parent) refresh
 * token. The parent token is only VALIDATED here — never rotated — so any number
 * of terminals can spawn concurrently without colliding. The resulting child
 * pair lives in memory only; the terminal then rotates its own refresh token in
 * isolation, so two terminals never fight over one rotating token (which would
 * trip the server's reuse-detection and revoke every session).
 */
// Turn a failed /auth/session/spawn into an accurate error.
//
// A 401 means the parent refresh token is gone — the machine login itself is dead, so
// clear it and announce (the UI flips to signed-out). EVERY OTHER status used to be
// reported as an expiry too, which actively misled: the common one is 429
// `CHILD_SESSION_CAP` ("Too many active terminals for this device. Sign one out and
// try again"), where /login is not the fix and the credentials are perfectly valid.
// Pass the server's own message through so the user learns what to actually do.
async function spawnFailure(res: Response): Promise<Error> {
  if (res.status === 401) {
    clearCredentials();
    notifySessionExpired();
    return new Error("Your Privateer session expired. Run /login to sign in again.");
  }
  let message: string | undefined;
  try {
    message = ((await res.json()) as { message?: string }).message;
  } catch {
    /* non-JSON body — fall back to the status line below */
  }
  return new Error(message?.trim() || `Couldn't start a Privateer session (HTTP ${res.status}).`);
}

async function spawnChildSession(): Promise<ChildSession> {
  const parent = loadCredentials();
  if (!parent) throw new Error("Not logged in to Privateer. Run /login.");
  // Present the parent access token as a possession proof alongside the refresh
  // token. The server allows this access token to be expired (the valid refresh
  // token is the liveness proof) — so the parent file stays read-only and never
  // needs rotating — but a refresh token WITHOUT a real signed access JWT can't
  // spawn. Both are validated server-side against the same account.
  const res = await postJson(serverBaseUrl(), "/auth/session/spawn", {
    refreshToken: parent.refreshToken,
    deviceLabel: defaultDeviceLabel(),
  }, {
    headers: { Authorization: `Bearer ${parent.accessToken}` },
  });
  if (!res.ok) throw await spawnFailure(res);
  const { accessToken, refreshToken } = (await res.json()) as ChildSession;
  _child = { accessToken, refreshToken };
  return _child;
}

/**
 * Eagerly spawn this terminal's child session at startup so an expired machine
 * login is announced (via onSessionExpired) at launch rather than surfacing as
 * an inference error on the first prompt of the day. Best effort: transient
 * network failures stay silent here — the first real request retries the spawn
 * and reports through the normal error path.
 */
export async function warmSession(): Promise<void> {
  if (!hasCredentials()) return;
  try {
    await ensureChildSession();
  } catch {
    /* expiry is announced via onSessionExpired; other failures retry on use */
  }
}

// Ensure a child session exists, de-duping concurrent spawns within this process.
function ensureChildSession(): Promise<ChildSession> {
  if (_child) return Promise.resolve(_child);
  if (!_spawnInFlight) {
    _spawnInFlight = spawnChildSession().finally(() => { _spawnInFlight = null; });
  }
  return _spawnInFlight;
}

// Rotate this terminal's own refresh token; if it's gone, spawn a fresh child.
// Single-flighted so concurrent 401s don't double-rotate (which would reuse-trip
// the child's own token).
function refreshChildSession(): Promise<ChildSession> {
  if (_refreshInFlight) return _refreshInFlight;
  _refreshInFlight = (async (): Promise<ChildSession> => {
    if (_child) {
      const res = await postJson(serverBaseUrl(), "/auth/refresh", { refreshToken: _child.refreshToken });
      if (res.ok) {
        const { accessToken, refreshToken } = (await res.json()) as ChildSession;
        _child = { accessToken, refreshToken };
        return _child;
      }
    }
    _child = null; // child rotation failed (expired/reused) — get a new one
    return spawnChildSession();
  })().finally(() => { _refreshInFlight = null; });
  return _refreshInFlight;
}

/**
 * fetch wrapper matching the global `fetch` signature, for use as the AI SDK
 * provider's `fetch`. Authenticates with THIS terminal's child session and, on a
 * 401, refreshes once and retries. The body is buffered so the retry can resend.
 */
export async function authedFetch(input: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> {
  const bodyBuf = init.body; // AI SDK passes a string body; safe to resend.
  // Use a Headers object and `.set` (case-insensitive) so OUR bearer replaces any
  // Authorization the caller already set. The AI SDK lowercases its headers and
  // sends `authorization: Bearer <placeholder apiKey>`; a plain spread that adds an
  // `Authorization` key would leave BOTH, which undici combines into
  // "Bearer placeholder, Bearer <real>" → the server rejects it as Invalid token.
  const withAuth = (token: string): RequestInit => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return { ...init, headers };
  };

  let child = await ensureChildSession();
  let res = await fetch(input, withAuth(child.accessToken));
  if (res.status === 401) {
    child = await refreshChildSession();
    res = await fetch(input, { ...withAuth(child.accessToken), body: bodyBuf });
  }
  return await defuseRetryableCap(res);
}

// A hard account cap (daily/monthly limit reached, balance exhausted) comes back
// as a 429, which the AI SDK treats as retryable — so it burns its whole retry
// budget waiting on a limit that won't clear, then surfaces a generic "Too Many
// Requests". Detect the cap by the backend's machine `code` and rewrite the status
// to 402 (Payment Required), which the SDK does NOT retry, while preserving the
// body and headers so describeError still shows the backend's own message. Only a
// 429 is inspected, and only its (small, non-streaming) error body is buffered;
// transient 429s without a cap code pass through untouched and stay retryable.
async function defuseRetryableCap(res: Response): Promise<Response> {
  if (res.status !== 429) return res;
  const body = await res.text();
  let code: unknown;
  try {
    const parsed = JSON.parse(body) as { code?: unknown; error?: { code?: unknown } };
    code = parsed.code ?? parsed.error?.code;
  } catch {
    /* non-JSON body — can't be a structured cap, leave it retryable */
  }
  const status = isAccountCapCode(typeof code === "string" ? code : undefined) ? 402 : 429;
  return new Response(body, { status, statusText: res.statusText, headers: res.headers });
}

/** Authenticated JSON request against the Privateer API (relative path). */
export async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const base = serverBaseUrl();
  return authedFetch(`${base}${path}`, init);
}

/**
 * DELETE the server-side session identified by `accessToken` (RFC-style bearer
 * possession proof). Deliberately a raw fetch, NOT authedFetch — authedFetch would
 * spawn/refresh a brand-new session just to kill this one. Bounded by a short
 * timeout so exit never hangs on a slow network, and all failures are swallowed;
 * the server's TTL is the fallback.
 */
async function deleteSession(accessToken: string, timeoutMs: number): Promise<void> {
  try {
    await fetch(`${serverBaseUrl()}/auth/session/current`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    /* best effort — the session expires server-side regardless */
  }
}

/**
 * Best-effort revoke of THIS terminal's child session (from authedFetch/apiRequest).
 * If no child was ever spawned (e.g. BYO-key run), there's nothing to do.
 */
export async function revokeChildSession(timeoutMs = 1500): Promise<void> {
  const child = _child;
  if (!child) return;
  _child = null; // never reuse a session we've asked the server to revoke
  await deleteSession(child.accessToken, timeoutMs);
}

/**
 * Best-effort revoke of the account-provider session (the one Pi drives for account
 * inference). Called both on EXPLICIT sign-out AND as part of exit cleanup (via
 * revokeLocalSessions) — safe in the exit path ONLY because the caller also drops Pi's
 * persisted copy (authStorage.remove("privateer")) so the next launch spawns fresh
 * rather than reusing this now-dead token. See the _account note and revokeLocalSessions.
 */
export async function revokeAccountSession(timeoutMs = 1500): Promise<void> {
  const account = _account;
  if (!account) return;
  _account = null;
  // Stop advertising this session as reclaimable BEFORE killing it: an entry left
  // behind would offer the next launch a dead row to adopt (it would fail over to a
  // spawn, but only after a wasted round trip).
  forgetOwnedSession();
  await deleteSession(account.accessToken, timeoutMs);
}

/**
 * Revoke ALL server-side sessions this terminal created — the in-memory child session
 * (authedFetch/apiRequest) AND the account-provider inference session — so the terminal
 * drops off the app's Linked Devices list the moment it exits (Ctrl+C, /quit, SIGTERM …)
 * instead of lingering until its token TTL (~24h). Best-effort, time-bounded, and the
 * two revokes run in parallel so a slow network can't double the exit delay.
 *
 * IMPORTANT: the account session is persisted by Pi (auth.json) and reused on the next
 * launch without a reactive-on-401 refresh, so the caller MUST also drop the persisted
 * copy right after this resolves — `authStorage.remove("privateer")` — or the next run
 * will reuse the token we just revoked and dead-end on a 401 (see the _account note).
 * Callers: cli/chat.ts cleanup() and daemon/index.ts shutdown().
 */
export async function revokeLocalSessions(timeoutMs = 1500): Promise<void> {
  await Promise.all([revokeChildSession(timeoutMs), revokeAccountSession(timeoutMs)]);
}

// ── Logout ───────────────────────────────────────────────────────────────────

/**
 * Log out this MACHINE: revoke the machine login and every terminal session
 * spawned from it, then wipe all local auth state. Other devices (the phone app,
 * another laptop) keep their own logins — each has its own token family.
 *
 * Two things this deliberately does NOT do, both of which it used to:
 *
 * 1. It does not POST /auth/logout. That endpoint calls revokeAllUserSessions —
 *    the entire ACCOUNT, every device including the app — while this function's
 *    contract (and its old doc comment) promised the opposite. Signing out of one
 *    terminal must not sign you out of your phone.
 *
 * 2. It does not go through apiRequest/authedFetch. Those authenticate with a CHILD
 *    session and spawn one if absent — so at the per-machine child cap the spawn
 *    throws 429 and the logout never reaches the server AT ALL. That was a deadlock:
 *    the cap blocked the one call that clears the cap. We authenticate with the
 *    PARENT instead, which is never subject to the cap.
 *
 * The parent's stored access token is usually expired (it is minted once at /login
 * and never rotated — the refresh token is the liveness proof), so we rotate for a
 * fresh one first. Rotation is free here precisely because we are destroying the
 * credential either way: nothing downstream needs the token we burn. rotateSession
 * is the no-ownership-side-effects variant, so this cannot clobber the registry
 * entry of a session we are about to revoke wholesale anyway.
 *
 * DELETE /auth/session/current then revokes the parent's family, which the server
 * cascades to every row with `parentFamilyId === familyId` — i.e. all this machine's
 * terminals, including the orphans left by terminals that died without their
 * shutdown hook. That cascade is what makes an accumulated cap self-clearing:
 * logout, log back in, and the machine starts from zero live children.
 *
 * Local state is wiped unconditionally at the end, whatever the network did. A
 * logout that can't reach the server must still leave you logged out locally —
 * the rows it failed to revoke age out on their TTL.
 */
export async function logout(): Promise<void> {
  const parent = loadCredentials();
  if (parent) {
    try {
      const fresh = await rotateSession(parent.refreshToken);
      await deleteSession(fresh.access, 5000);
    } catch {
      /* offline, or the login was already dead server-side — wipe locally anyway */
    }
  }
  // In-memory sessions are gone with the family above; drop the handles so nothing
  // tries to revoke them individually on the way out.
  _child = null;
  _account = null;
  clearOwnedSessions(); // every entry named a session the cascade just killed
  clearCredentials();
}

// ── Account provider (Pi OAuth) credential helpers ───────────────────────────
// The `privateer` account inference provider registers with Pi via the OAuth path
// (ProviderConfigInput.oauth). Pi treats a credential as { access, refresh, expires }
// and refreshes when Date.now() >= expires. We map a per-terminal CHILD session onto
// that shape: `access` = child access JWT, `refresh` = child refresh token, `expires`
// = the JWT's exp (so Pi refreshes just before the server would reject it). These are
// independent of authedFetch's in-memory _child (Pi owns this credential's lifecycle).

export interface AccountCredential {
  access: string;
  refresh: string;
  expires: number; // ms epoch
}

// Decode a JWT's `exp` (seconds) → ms epoch minus a safety skew, or a short fallback
// so an undecodable token still gets refreshed frequently rather than never.
function jwtExpMs(token: string, fallbackMs = 5 * 60_000): number {
  try {
    const seg = token.split(".")[1];
    const payload = JSON.parse(Buffer.from(seg, "base64").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp === "number") return payload.exp * 1000 - 30_000; // 30s skew
  } catch {
    /* not a decodable JWT */
  }
  return Date.now() + fallbackMs;
}

// Spawn a fresh child session (from the parent machine login) as an account credential.
export async function spawnAccountCredentials(): Promise<AccountCredential> {
  const parent = loadCredentials();
  if (!parent) throw new Error("Not logged in to Privateer. Run /login.");
  const res = await postJson(
    serverBaseUrl(),
    "/auth/session/spawn",
    { refreshToken: parent.refreshToken, deviceLabel: defaultDeviceLabel() },
    { headers: { Authorization: `Bearer ${parent.accessToken}` } },
  );
  if (!res.ok) throw await spawnFailure(res);
  const { accessToken, refreshToken } = (await res.json()) as { accessToken: string; refreshToken: string };
  _account = { accessToken }; // track for explicit sign-out revoke (revokeAccountSession)
  const cred = { access: accessToken, refresh: refreshToken, expires: jwtExpMs(accessToken) };
  recordOwnedSession(cred); // claim the row, so a crash leaves it reclaimable
  return cred;
}

// An /auth/refresh the server actively REFUSED, as opposed to one that never got an
// answer. Only the former proves the session is gone; a network failure says nothing,
// and treating it as death would leak the row (see dropOwnedSession).
export interface RefreshRejection extends Error {
  status: number;
}

export function isRefreshRejection(e: unknown): e is RefreshRejection {
  return e instanceof Error && typeof (e as RefreshRejection).status === "number";
}

// Rotate a session's refresh token, with NO ownership side effects. Split out from
// refreshAccountCredentials so orphan cleanup can rotate a session purely to obtain a
// token it can revoke with, without claiming that session as this terminal's own.
async function rotateSession(refresh: string): Promise<AccountCredential> {
  const res = await postJson(serverBaseUrl(), "/auth/refresh", { refreshToken: refresh });
  if (!res.ok) {
    const err = new Error(`account refresh failed (${res.status})`) as RefreshRejection;
    err.status = res.status;
    throw err;
  }
  const { accessToken, refreshToken } = (await res.json()) as { accessToken: string; refreshToken: string };
  return { access: accessToken, refresh: refreshToken, expires: jwtExpMs(accessToken) };
}

// Rotate this account credential's own refresh token; caller falls back to a fresh
// spawn if this throws (expired/reused child token).
export async function refreshAccountCredentials(refresh: string): Promise<AccountCredential> {
  const cred = await rotateSession(refresh);
  _account = { accessToken: cred.access }; // the rotated session is the one an explicit sign-out revokes
  // Re-claim on every rotation — including the ones Pi drives on expiry — so the
  // registry always holds a token that would actually work if we crashed right now.
  recordOwnedSession(cred);
  return cred;
}

// Get an account credential for THIS terminal, reusing a session orphaned by a
// terminal that died without revoking rather than stacking another row on top of it.
//
// Reclaiming is what keeps a crash from costing a permanent session slot: each orphan
// otherwise sits on the server for its full TTL, and enough of them earn a
// `429 CHILD_SESSION_CAP` on the next spawn. A successful /auth/refresh doubles as the
// liveness probe — it proves the row is real and hands back a usable access token —
// so an orphan that turns out to be dead just falls through to the next candidate.
//
// Orphans we don't adopt are revoked in the background: their terminal is gone, so the
// row is pure waste, and freeing it is what actually unwinds an account already at the
// cap. Never touches a session whose owner is still running (see accountSessions.ts).
export async function acquireAccountCredential(): Promise<AccountCredential> {
  const orphans = orphanedSessions();
  let adopted: AccountCredential | null = null;
  let attempted = 0;

  while (attempted < orphans.length && !adopted) {
    const orphan = orphans[attempted++];
    try {
      adopted = await refreshAccountCredentials(orphan.refresh);
      dropOwnedSession(orphan.pid); // the rotation above re-recorded it under OUR pid
    } catch (e) {
      // Refused → the session is gone; stop tracking it. Unreachable → keep it, so a
      // network blip doesn't strand a live row we could have reclaimed next launch.
      if (isRefreshRejection(e)) dropOwnedSession(orphan.pid);
    }
  }

  // Best-effort cleanup of the ones we didn't need. Detached: freeing slots must never
  // delay startup, and a failure here costs nothing the next launch can't retry.
  const leftovers = orphans.slice(attempted);
  if (leftovers.length) void revokeOrphanedSessions(leftovers);

  return adopted ?? (await spawnAccountCredentials());
}

// Revoke sessions whose terminal is gone. Revoking needs a LIVE access token
// (DELETE /auth/session/current is Bearer-authenticated) and an orphan's stored one is
// usually stale, so rotate first — via rotateSession, which deliberately does NOT claim
// ownership: these sessions are being destroyed, not adopted, and recording them would
// overwrite the entry for the credential this terminal is actually using.
async function revokeOrphanedSessions(orphans: OwnedSession[], timeoutMs = 1500): Promise<void> {
  for (const orphan of orphans) {
    try {
      const cred = await rotateSession(orphan.refresh);
      await deleteSession(cred.access, timeoutMs);
      dropOwnedSession(orphan.pid);
    } catch (e) {
      if (isRefreshRejection(e)) dropOwnedSession(orphan.pid);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("Login cancelled."));
      },
      { once: true },
    );
  });
}
