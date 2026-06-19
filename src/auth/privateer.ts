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

// Resolved base URL: env override > stored (from a prior login) > default.
export function serverBaseUrl(): string {
  const env = process.env.PRIVATEER_SERVER_URL?.replace(/\/$/, "");
  if (env) return env;
  return (loadCredentials()?.serverBaseUrl || DEFAULT_SERVER_URL).replace(/\/$/, "");
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

// ── Credential storage (0600, like saveGlobalConfig) ─────────────────────────

let _cache: Credentials | null | undefined;

export function loadCredentials(): Credentials | null {
  if (_cache !== undefined) return _cache;
  const path = credentialsPath();
  if (!existsSync(path)) return (_cache = null);
  try {
    _cache = JSON.parse(readFileSync(path, "utf8")) as Credentials;
  } catch {
    _cache = null;
  }
  return _cache;
}

export function saveCredentials(creds: Credentials): void {
  const dir = globalDir();
  mkdirSync(dir, { recursive: true });
  tryChmod(dir, 0o700);
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify(creds, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  tryChmod(path, 0o600);
  _cache = creds;
}

export function clearCredentials(): void {
  try {
    rmSync(credentialsPath(), { force: true });
  } catch {
    /* nothing to remove */
  }
  _cache = null;
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
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    body: JSON.stringify(body),
    ...init,
  });
}

// Step 1: ask the server for a device + user code the human will approve in-app.
export async function requestDeviceCode(deviceLabel = defaultDeviceLabel()): Promise<DeviceCode> {
  const base = serverBaseUrl();
  const res = await postJson(base, "/auth/device/code", { deviceLabel });
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
      const data = (await res.json()) as Omit<Credentials, "serverBaseUrl">;
      const creds: Credentials = { ...data, serverBaseUrl: base };
      saveCredentials(creds);
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

async function refreshTokens(): Promise<Credentials> {
  const creds = loadCredentials();
  if (!creds) throw new Error("Not logged in.");
  const res = await postJson(creds.serverBaseUrl, "/auth/refresh", { refreshToken: creds.refreshToken });
  if (!res.ok) {
    // TOKEN_REUSE / invalid refresh → the session is gone; force a fresh login.
    clearCredentials();
    throw new Error("Your Privateer session expired. Run /login to sign in again.");
  }
  const { accessToken, refreshToken } = (await res.json()) as { accessToken: string; refreshToken: string };
  const next: Credentials = { ...creds, accessToken, refreshToken };
  saveCredentials(next); // persist the ROTATED pair — old refresh token is now dead
  return next;
}

/**
 * fetch wrapper matching the global `fetch` signature, for use as the AI SDK
 * provider's `fetch`. Injects the bearer token and, on a 401, refreshes once
 * and retries. The body is buffered so the retry can resend it.
 */
export async function authedFetch(input: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> {
  const creds = loadCredentials();
  if (!creds) throw new Error("Not logged in to Privateer. Run /login.");

  const bodyBuf = init.body; // AI SDK passes a string body; safe to resend.
  const withAuth = (token: string): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
  });

  let res = await fetch(input, withAuth(creds.accessToken));
  if (res.status === 401) {
    const refreshed = await refreshTokens();
    res = await fetch(input, { ...withAuth(refreshed.accessToken), body: bodyBuf });
  }
  return res;
}

/** Authenticated JSON request against the Privateer API (relative path). */
export async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const base = serverBaseUrl();
  return authedFetch(`${base}${path}`, init);
}

// ── Logout ───────────────────────────────────────────────────────────────────

/**
 * Log out this terminal: revoke its session server-side (best effort) and wipe
 * local credentials. Other devices/sessions are untouched.
 */
export async function logout(): Promise<void> {
  try {
    await apiRequest("/auth/logout", { method: "POST" });
  } catch {
    /* best effort — clear locally regardless */
  }
  clearCredentials();
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
