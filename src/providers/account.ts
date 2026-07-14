// The `privateer` account provider — run inference billed to the user's Privateer
// subscription instead of a BYO key. This is the one provider the plan flags as a
// genuine code-blocker (Appendix A): it can't be a static key — it uses a rotating,
// 401-refreshing child session against the account channel (`${server}/api/agent/v1`).
//
// We register it via Pi's OAuth path (ProviderConfigInput.oauth). Pi drives the
// credential lifecycle: it calls getApiKey(cred) per request and refreshToken(cred)
// when Date.now() >= cred.expires. We map a per-terminal child session onto that
// shape (see auth/privateer.ts spawn/refreshAccountCredentials). Because the machine
// login already exists (~/.privateer/credentials.json), login() just spawns a child;
// only a first-ever machine login runs the device-code flow.

import {
  serverBaseUrl,
  hasCredentials,
  runDeviceLogin,
  authedFetch,
  spawnAccountCredentials,
  refreshAccountCredentials,
  notifySignedIn,
} from "../auth/privateer.ts";
import { interpretReport, teePosture, tierFromTeePosture, type PrivacyTier } from "pi-privacy";
import { ACCOUNT_DEFAULT_MODEL_ID, ensurePiDefaultModel } from "./defaultModel.ts";

// Seed/fallback catalog: registered synchronously so the account provider has real
// models the instant it loads (before the live /api/models fetch resolves) — in
// particular the signed-in default, near/zai-org/GLM-5.1-FP8, resolves at startup
// without a "model not found" warning. The first entry is that default: a NEAR
// confidential-compute (TEE, attestable) model — the strongest privacy tier. Also the
// fallback list if the live listing can't be reached.
const DEFAULT_MODELS = [
  ACCOUNT_DEFAULT_MODEL_ID,
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-5.5",
  "deepseek/deepseek-v4-flash",
];

function seedModel(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

// Fetch the account channel's enabled model catalog. `GET /api/models` is the server's
// public list of billable models (`{ models: [{ modelId }] }`) — the same set the app
// shows. (The `/api/agent/v1` base only implements chat/completions, no /models route.)
// Falls back to DEFAULT_MODELS on any failure.
export async function fetchAccountModels(): Promise<string[]> {
  try {
    const res = await fetch(`${serverBaseUrl()}/api/models`);
    if (!res.ok) return DEFAULT_MODELS;
    const data = (await res.json()) as { models?: { modelId?: string }[] };
    const ids = (data.models ?? []).map((m) => m.modelId).filter((x): x is string => !!x);
    return ids.length ? ids : DEFAULT_MODELS;
  } catch {
    return DEFAULT_MODELS;
  }
}

// The Pi OAuth provider (Omit<OAuthProviderInterface, "id"> — Pi supplies the id from
// the provider name). login/refreshToken/getApiKey are the whole contract.
export const privateerOAuthProvider = {
  name: "Privateer account",
  usesCallbackServer: false,
  // Pi's login dialog passes `signal` (its cancel AbortController) alongside the
  // callbacks. We MUST thread it into runDeviceLogin — otherwise escape/ctrl+c
  // aborts the dialog's signal but our poll loop never sees it, the login()
  // promise never settles, and Pi never restores the editor: the "Waiting for
  // authentication…" screen hangs with no way out. See auth/privateer.ts
  // pollForToken, which checks the signal and rejects with "Login cancelled.".
  async login(cb: { onDeviceCode?: (info: unknown) => void; signal?: AbortSignal }) {
    // Fresh machine? The device-code flow below fires notifySignedIn itself (via
    // pollForToken). Already linked? No device code runs — so we announce the
    // completed subscription login ourselves at the end, or the header/badge would
    // keep showing "not signed in" until the next launch.
    const wasLinked = hasCredentials();
    if (!wasLinked) {
      try {
        await runDeviceLogin({
          signal: cb.signal,
          onCode: (code) =>
            cb.onDeviceCode?.({
              userCode: code.user_code,
              verificationUri: code.verification_uri_complete ?? code.verification_uri ?? "",
              intervalSeconds: code.interval,
              expiresInSeconds: code.expires_in,
            }),
        });
      } catch (e) {
        // Normalize the cancel message to exactly "Login cancelled" (no period):
        // Pi's login dialog only suppresses its "Failed to login…" error toast for
        // that exact string, so a cancel should exit quietly, not flash an error.
        if (cb.signal?.aborted) throw new Error("Login cancelled");
        throw e;
      }
    }
    if (cb.signal?.aborted) throw new Error("Login cancelled");
    const creds = await spawnAccountCredentials();
    // Seed Pi's saved model default to the account channel, so the next launch resolves
    // to a billable subscription model instead of falling through to a keyless built-in
    // (the "No API key found for openrouter" trap). No-op if the user already has a
    // chosen default. See providers/defaultModel.ts.
    ensurePiDefaultModel();
    // The fresh path already fired notifySignedIn (pollForToken); fire here for the
    // already-linked path so the header re-renders to "connected" on this terminal too.
    if (wasLinked) notifySignedIn();
    return creds;
  },
  async refreshToken(creds: { refresh: string }) {
    try {
      return await refreshAccountCredentials(creds.refresh);
    } catch {
      // child token expired/reused → spawn a fresh one from the parent login.
      return spawnAccountCredentials();
    }
  },
  getApiKey(creds: { access: string }): string {
    return creds.access;
  },
};

// Which privacy channel an account model routes through: NEAR confidential-compute
// (TEE, attestable) for `near/`-prefixed ids, else a server-side ZDR channel.
// Ported from tree-cli resolve.ts.
export function privateerChannel(modelId: string): "tee" | "zdr" {
  return modelId.startsWith("near/") ? "tee" : "zdr";
}

export interface AccountPosture {
  tier: PrivacyTier;
  teePosture?: "green" | "yellow" | "red";
  error?: string;
}

// Posture for an account-channel model. For NEAR models the attestation is fetched
// through the SERVER proxy (the account's NEAR key stays server-side): the server
// mints the nonce and returns the report. A green attestation is trusted as a genuine
// TEE — promoted to `tee-verified` (green shield "Trusted Execution" in the badge) —
// so an attested confidential-compute model reads as verified-private. A yellow report
// stays `tee-unverified` (unconfirmed) and red falls back to `standard`; the raw
// teePosture is still surfaced for display. ZDR-channel models route to
// zero-retention endpoints server-side, which we can't observe here — a policy claim.
export async function accountPosture(modelId: string): Promise<AccountPosture> {
  if (privateerChannel(modelId) === "zdr") {
    return { tier: "zdr-policy" };
  }
  try {
    const res = await authedFetch(
      `${serverBaseUrl()}/api/models/near/attestation?model=${encodeURIComponent(modelId)}`,
    );
    if (!res.ok) return { tier: "tee-unverified", error: `HTTP ${res.status}` };
    const data = (await res.json()) as { nonce?: string; report?: unknown };
    const att = interpretReport(modelId, data.nonce ?? "", data.report ?? {});
    const tp = teePosture(att);
    // green → tee-verified, yellow → tee-unverified, red → standard.
    const tier: PrivacyTier = tierFromTeePosture(tp);
    return { tier, teePosture: tp };
  } catch (e) {
    return { tier: "tee-unverified", error: (e as Error).message };
  }
}

// Extension factory: registers the account provider so `/login` can offer it.
//
// We register UNCONDITIONALLY (not only when a machine login already exists). Pi's
// `/login` builds its "Use a subscription" list from the OAuth providers registered
// here (authStorage.getOAuthProviders()); a not-yet-logged-in machine has no
// credentials, so gating registration on hasCredentials() left `/login` with no
// Privateer option — the classic chicken-and-egg where you can't log in because
// you're not logged in. The OAuth provider's login() itself runs the device-code
// flow when hasCredentials() is false (see privateerOAuthProvider.login), so first
// login works entirely through Pi once the provider is present.
//
// Registration is SYNCHRONOUS (seeded with the fallback), then refined once the live
// catalog is fetched. This matters: Pi flushes provider registrations made during the
// synchronous extension-init pass before it binds extensions, so the `privateer`
// provider (and its OAuth login path) exist immediately — before the model picker can
// open. If we instead awaited the network fetch first, the registration could land
// after the picker built its list, and privateer models would be missing until reopen.
// registerProvider replaces the provider's models on the second call, and the picker's
// refresh() re-applies registered providers, so the full list appears once fetched.
export function makeAccountProvider() {
  return (pi: {
    registerProvider?: (name: string, config: unknown) => void;
  }): void => {
    if (typeof pi.registerProvider !== "function") return;
    const register = (ids: string[]): void =>
      pi.registerProvider!("privateer", {
        name: "Privateer account",
        baseUrl: `${serverBaseUrl()}/api/agent/v1`,
        api: "openai-completions",
        oauth: privateerOAuthProvider,
        models: ids.map(seedModel),
      });
    register(DEFAULT_MODELS); // immediate: provider exists this tick
    void fetchAccountModels()
      .then((ids) => ids.length && register(ids)) // refine to the live catalog
      .catch(() => {
        /* keep the fallback model */
      });
  };
}
