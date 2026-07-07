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
} from "../auth/privateer.ts";
import { interpretReport, teePosture, tierFromTeePosture, type PrivacyTier } from "pi-privacy";

// Fallback model if the account listing can't be reached (kept from the 0.2 catalog
// default — a NEAR confidential-compute model, the strongest privacy tier).
const DEFAULT_MODELS = ["near/deepseek-ai/DeepSeek-V4-Flash"];

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

// Fetch the account channel's live model list (OpenAI-compat /models), authed with a
// child session. Falls back to DEFAULT_MODELS on any failure.
export async function fetchAccountModels(): Promise<string[]> {
  try {
    const res = await authedFetch(`${serverBaseUrl()}/api/agent/v1/models`);
    if (!res.ok) return DEFAULT_MODELS;
    const data = (await res.json()) as { data?: { id?: string }[] };
    const ids = (data.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
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
  async login(cb: { onDeviceCode?: (info: unknown) => void }) {
    if (!hasCredentials()) {
      await runDeviceLogin({
        onCode: (code) =>
          cb.onDeviceCode?.({
            userCode: code.user_code,
            verificationUri: code.verification_uri_complete ?? code.verification_uri ?? "",
            intervalSeconds: code.interval,
            expiresInSeconds: code.expires_in,
          }),
      });
    }
    return spawnAccountCredentials();
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

// Posture for an account-channel model. NEAR models are cryptographically verified
// via the server-proxy attestation (the account's NEAR key stays server-side; the
// server mints the nonce and returns the report, which we interpret exactly like a
// direct attestation). ZDR-channel models route to zero-retention endpoints
// server-side, which we can't observe from here — honestly a policy claim.
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
    return { tier: tierFromTeePosture(tp), teePosture: tp };
  } catch (e) {
    return { tier: "tee-unverified", error: (e as Error).message };
  }
}

// Extension factory: registers the account provider (with its live model list) when
// a machine login exists. No login → nothing registered (BYO-key only).
export function makeAccountProvider() {
  return async (pi: {
    registerProvider?: (name: string, config: unknown) => void;
  }): Promise<void> => {
    if (!hasCredentials() || typeof pi.registerProvider !== "function") return;
    const ids = await fetchAccountModels();
    pi.registerProvider("privateer", {
      name: "Privateer account",
      baseUrl: `${serverBaseUrl()}/api/agent/v1`,
      api: "openai-completions",
      oauth: privateerOAuthProvider,
      models: ids.map(seedModel),
    });
  };
}
