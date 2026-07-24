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
  type AccountCredential,
  serverBaseUrl,
  hasCredentials,
  runDeviceLogin,
  authedFetch,
  acquireAccountCredential,
  refreshAccountCredentials,
  notifySignedIn,
} from "../auth/privateer.ts";
import { interpretReport, teePosture, tierFromTeePosture, type PrivacyTier } from "pi-privacy";
import { ACCOUNT_DEFAULT_MODEL_ID, ACCOUNT_NEAR_MODEL_ID, ensurePiDefaultModel } from "./defaultModel.ts";
import {
  sealedEnabled,
  sealedProviderFor,
  sealedShimBase,
  ensureSealedShim,
  attestSealed,
} from "./sealedShim.ts";

// Seed/fallback catalog: registered synchronously so the account provider has real
// models the instant it loads (before the live /api/models fetch resolves) — in
// particular the default, tinfoil/glm-5-2, resolves at startup without a "model not
// found" warning, which matters more than ever now that a signed-OUT terminal also
// launches on it. The first two entries are the TEE tiers (Tinfoil, then NEAR); the
// rest are the familiar names. Also the fallback list if the live listing is
// unreachable.
const DEFAULT_MODELS = [
  ACCOUNT_DEFAULT_MODEL_ID,
  ACCOUNT_NEAR_MODEL_ID,
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

// One catalog entry with its server-asserted baseline privacy tier.
export interface AccountModelInfo {
  id: string;
  tier: PrivacyTier;
}

// The set of tier strings pi-privacy defines (posture/tiers.ts). We only trust a
// server-supplied tier if it's one of these — anything else falls back to a prefix
// heuristic, so a server typo or older/newer server can never inject a bogus tier.
const VALID_TIERS = new Set<PrivacyTier>([
  "tee-verified",
  "tee-unverified",
  "local",
  "zdr-enforced",
  "zdr-policy",
  "standard",
]);

// Baseline tier when the server doesn't (yet) send one. Honest-labeling rule: a
// confidential-compute model is only *claimed* here (tee-unverified) — the picker
// upgrades it to tee-verified live via attestation (accountPosture). Everything
// else with no server signal is "standard": we don't assert ZDR we can't back.
function tierFromPrefix(modelId: string): PrivacyTier {
  return modelId.startsWith("near/") || modelId.startsWith("tinfoil/") ? "tee-unverified" : "standard";
}

function normalizeTier(tier: string | undefined, modelId: string): PrivacyTier {
  return tier && VALID_TIERS.has(tier as PrivacyTier) ? (tier as PrivacyTier) : tierFromPrefix(modelId);
}

// Baseline tiers for the account catalog, keyed by modelId. Populated by
// fetchAccountCatalog() so the /models picker can shield each row without re-fetching.
// A live NEAR attestation (accountPosture) can still upgrade a row to tee-verified.
const accountTierMap = new Map<string, PrivacyTier>();

// The server-asserted baseline tier for an account model, or undefined if we haven't
// seen it in a catalog fetch. Used by the /models picker (privateer-models.ts).
export function accountBaselineTier(modelId: string): PrivacyTier | undefined {
  return accountTierMap.get(modelId);
}

// Whether a catalog fetch has populated the tier map at least once. The /models
// picker uses this to decide if it must fetch before opening (first-open race with
// the provider's background fetch) vs. render immediately from the cached tiers.
export function accountCatalogLoaded(): boolean {
  return accountTierMap.size > 0;
}

// Fetch the account channel's enabled model catalog WITH per-model privacy tiers.
// `GET /api/models` is the server's public list of billable models
// (`{ models: [{ modelId, privacy: { tier } }] }`) — the same set the app shows.
// (The `/api/agent/v1` base only implements chat/completions, no /models route.)
// Falls back to DEFAULT_MODELS (prefix-derived tiers) on any failure. Side effect:
// refreshes accountTierMap.
export async function fetchAccountCatalog(): Promise<AccountModelInfo[]> {
  const fallback = (): AccountModelInfo[] =>
    DEFAULT_MODELS.map((id) => ({ id, tier: tierFromPrefix(id) }));
  let infos: AccountModelInfo[];
  try {
    const res = await fetch(`${serverBaseUrl()}/api/models`);
    if (!res.ok) {
      infos = fallback();
    } else {
      const data = (await res.json()) as {
        models?: { modelId?: string; privacy?: { tier?: string } }[];
      };
      const parsed = (data.models ?? [])
        .map((m) => (m.modelId ? { id: m.modelId, tier: normalizeTier(m.privacy?.tier, m.modelId) } : null))
        .filter((x): x is AccountModelInfo => !!x);
      infos = parsed.length ? parsed : fallback();
    }
  } catch {
    infos = fallback();
  }
  accountTierMap.clear();
  for (const info of infos) accountTierMap.set(info.id, info.tier);
  return infos;
}

// Back-compat id-only view over fetchAccountCatalog (registerProvider only needs ids).
export async function fetchAccountModels(): Promise<string[]> {
  return (await fetchAccountCatalog()).map((m) => m.id);
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
    // Go through the process-wide, single-flighted accessor rather than acquiring
    // directly. The device flow above already fired notifySignedIn, whose listeners arm
    // the account channel — so a bare acquire here would race that one and mint a SECOND
    // server-side session (a duplicate row in Linked Devices, and a step closer to
    // 429 CHILD_SESSION_CAP). Sharing the in-flight promise makes it exactly one.
    const creds = await accountCredential();
    // Seed Pi's saved model default to the account channel, so the next launch resolves
    // to a billable subscription model instead of falling through to a keyless built-in
    // (the "No API key found for openrouter" trap). No-op if the user already has a
    // chosen default. See providers/defaultModel.ts.
    ensurePiDefaultModel();
    // Announce the completed login — ALWAYS, on both paths, and only now that the
    // account channel actually holds a credential.
    //
    // The fresh path fires this once already, from pollForToken, the instant
    // credentials.json is written. That's the right moment for the header, and the
    // wrong one for the model: the listener that moves the live session onto an
    // account model would run while this spawn was still in flight and find no key.
    // Firing again here is what makes the switch land. Listeners are documented as
    // idempotent (see notifySignedIn), and the model switch no-ops when it's already
    // on target, so the double signal costs nothing.
    notifySignedIn();
    return creds;
  },
  async refreshToken(creds: { refresh: string }) {
    let next: AccountCredential;
    try {
      next = await refreshAccountCredentials(creds.refresh);
    } catch {
      // Child token expired/reused → get another. acquire (not spawn) so a terminal
      // that already holds the device's last session slot can reclaim an orphan
      // instead of being refused a fresh one mid-session.
      next = await acquireAccountCredential();
    }
    // Keep the process memo on the CURRENT token: the one it replaced is dead, and
    // handing a dead token to a later arm() would 401 on the first prompt.
    rememberAccountCredential(next);
    return next;
  },
  getApiKey(creds: { access: string }): string {
    return creds.access;
  },
};

// Confidential-compute prefixes in the account catalog: every model the server serves
// out of a TEE. `near/` is the one we can attest end to end from here (the server
// proxies a nonce'd quote); `tinfoil/` and `phala/` are equally real enclaves whose
// attestation we cannot bind to THIS connection through the proxy — see accountPosture.
const TEE_PREFIXES = ["near/", "tinfoil/", "phala/"];

// Which privacy channel an account model routes through: confidential compute (TEE)
// for the prefixes above, else a server-side ZDR channel. Ported from tree-cli
// resolve.ts, then widened — it used to say `near/` only, which quietly labelled the
// default model (tinfoil/glm-5-2, a TEE model) as a mere ZDR policy claim.
export function privateerChannel(modelId: string): "tee" | "zdr" {
  return TEE_PREFIXES.some((p) => modelId.startsWith(p)) ? "tee" : "zdr";
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
  // Sealed (EHBP) path. When sealed mode is on and the model has a Node sealed
  // client (tinfoil/*), inference goes through the blind relay with the body
  // HPKE-sealed to the enclave, and we attest that enclave client-side with the SAME
  // SecureClient that carries the tokens. A green ready() is a quote WE checked,
  // bound to the HPKE key we seal to — so it earns tee-verified. A failure stays
  // tee-unverified with the reason surfaced (never a silent green). See
  // docs/tee-privateer-tinfoil-ehbp.md.
  const sealedProvider = sealedEnabled() ? sealedProviderFor(modelId) : null;
  if (sealedProvider) {
    const att = await attestSealed(sealedProvider);
    return att.ok ? { tier: "tee-verified" } : { tier: "tee-unverified", error: att.error };
  }
  // Honest labelling for the non-NEAR enclaves without sealed mode. Tinfoil and Phala
  // publish real attestations, but the server proxies the inference in cleartext, so
  // from here we cannot bind a quote to the connection actually carrying our tokens —
  // only the account's word that it did. That's `tee-unverified` (yellow "confidential
  // compute, unconfirmed"), never the green tee-verified we reserve for a quote we
  // checked ourselves. Turn on sealed mode (PRIVATEER_SEALED=1) for the verified
  // shield, or set TINFOIL_API_KEY and run `tinfoil/*` direct (pi-privacy attests
  // client-side over the TLS binding).
  if (!modelId.startsWith("near/")) {
    return { tier: "tee-unverified" };
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
    on?: (event: string, handler: (e: unknown, ctx: unknown) => void) => void;
  }): void => {
    if (typeof pi.registerProvider !== "function") return;
    // A model entry, with a per-model baseUrl override for sealed models once the
    // EHBP shim is listening: `tinfoil/*` then route through the loopback shim (which
    // seals to the blind relay) instead of the cleartext `/api/agent/v1` proxy.
    // Everything else keeps the provider baseUrl below. Until the shim is up (or when
    // sealed mode is off) sealed models fall back to the cleartext path — and the
    // badge stays honestly `tee-unverified` (see accountPosture).
    const modelEntry = (id: string) => {
      const base = seedModel(id);
      const provider = sealedEnabled() ? sealedProviderFor(id) : null;
      const shim = sealedShimBase();
      return provider && shim ? { ...base, baseUrl: `${shim}/${provider}/v1` } : base;
    };
    let lastIds: string[] = DEFAULT_MODELS;
    const register = (ids: string[]): void => {
      lastIds = ids;
      pi.registerProvider!("privateer", {
        name: "Privateer account",
        baseUrl: `${serverBaseUrl()}/api/agent/v1`,
        api: "openai-completions",
        oauth: privateerOAuthProvider,
        models: ids.map(modelEntry),
      });
    };
    register(DEFAULT_MODELS); // immediate: provider exists this tick
    // Bring up the sealed shim, then re-register so sealed models pick up their shim
    // baseUrl. Registration re-runs anyway after the catalog fetch; this just makes
    // sure the switch lands even if the fetch is slow or fails.
    if (sealedEnabled()) {
      void ensureSealedShim()
        .then(() => register(lastIds))
        .catch(() => {
          /* shim failed to start → sealed models stay on the cleartext path */
        });
    }
    // Refine to the live catalog. fetchAccountCatalog also populates accountTierMap
    // as a side effect, so the /models picker can shield each row without re-fetching.
    void fetchAccountCatalog()
      .then((infos) => infos.length && register(infos.map((m) => m.id)))
      .catch(() => {
        /* keep the fallback model */
      });

    // Seed the account channel's credential at launch. Nothing else does this in the
    // TUI: Pi only obtains an OAuth credential by running /login, and our shutdown
    // hook deliberately REVOKES the account session and deletes its persisted
    // auth.json entry (see the LIFECYCLE HAZARD note in src/auth/privateer.ts). So a
    // signed-in user who quits and relaunches lands on privateer/* with no key at
    // all, and the first prompt dead-ends on "No API key found for privateer." — even
    // though the banner says "connected". The REPL (cli/chat.ts) and the harbor
    // already spawn one at startup; this gives the TUI the same seed.
    pi.on?.("session_start", (_e, ctx) => void armAccountCredential(ctx));
  };
}

// ── Arming the account channel ───────────────────────────────────────────────
//
// ONE account session per PROCESS. Every mint is expensive and visible: it's a row in
// the app's Linked Devices list, and the server caps how many a device may hold
// (429 CHILD_SESSION_CAP). session_start alone fires for new/resume/fork/reload, and a
// mid-session /login wants the channel armed too — so the credential is minted once
// and then remembered, and later callers reuse it instead of stacking another row.
//
// Both the memo and its in-flight promise live on globalThis rather than in module
// scope, because jiti gives each extension its OWN instance of this file (see the note
// in auth/privateer.ts). privateer-account seeds at launch and privateer-brand arms
// after a sign-in; module-scoped state would let each mint its own session.
//
// A fresh PROCESS always mints: a run that crashed without its shutdown hook can leave
// a REVOKED credential persisted in auth.json with a still-valid-looking `expires`,
// which Pi would happily reuse and 401 on.
const ARMED = Symbol.for("privateer.accountCredential");
type ArmedSlot = {
  [ARMED]?: { cred?: AccountCredential; inFlight?: Promise<AccountCredential> };
};

function armSlot(): NonNullable<ArmedSlot[typeof ARMED]> {
  const g = globalThis as ArmedSlot;
  return (g[ARMED] ??= {});
}

// Record a credential this process minted so nothing mints a second one. Exported for
// the OAuth login path, which acquires its credential for Pi to own and would
// otherwise leave the next arm() with nothing to reuse.
export function rememberAccountCredential(cred: AccountCredential): void {
  armSlot().cred = cred;
}

// The remembered credential, if it's still usable. A minute of headroom: handing back
// one that expires mid-request just trades a spawn for a 401.
function liveAccountCredential(): AccountCredential | undefined {
  const cred = armSlot().cred;
  return cred && cred.expires > Date.now() + 60_000 ? cred : undefined;
}

// Get this process's account credential, minting one only if we don't already hold a
// live one. Single-flighted, so two callers racing (session_start and a sign-in) share
// one spawn rather than opening two sessions.
async function accountCredential(): Promise<AccountCredential> {
  const live = liveAccountCredential();
  if (live) return live;
  const slot = armSlot();
  slot.inFlight ??= acquireAccountCredential()
    .then((cred) => {
      slot.cred = cred;
      return cred;
    })
    .finally(() => {
      slot.inFlight = undefined;
    });
  return slot.inFlight;
}

// `ctx` is Pi's ExtensionContext; the auth store hangs off its model registry (the same
// path privateer-brand uses to DROP the credential on sign-out).
type SeedContext = {
  modelRegistry?: { authStorage?: { set?: (provider: string, cred: unknown) => void } };
  hasUI?: boolean;
  ui?: { notify?: (message: string, level: string) => void };
};

// Put a working account credential into Pi's auth store, so `privateer/*` models can
// actually run. Called at session_start (the launch seed) and again right after a
// sign-in (see the brand extension) — a mid-session /login has to arm the channel
// itself, because Pi writes an OAuth credential only for a login IT drove, never for
// our own /login device-code command.
//
// Returns true when the channel is armed. `notify` controls whether a failure is
// announced: the launch seed says so out loud, while a caller that reports the outcome
// itself (the sign-in path) passes false so the user doesn't read it twice.
export async function armAccountCredential(
  ctx: unknown,
  opts: { notify?: boolean } = {},
): Promise<boolean> {
  if (!hasCredentials()) return false;
  const store = (ctx as SeedContext)?.modelRegistry?.authStorage;
  if (typeof store?.set !== "function") return false;
  try {
    store.set("privateer", { type: "oauth", ...(await accountCredential()) });
    return true;
  } catch (e) {
    // The account channel is NOT armed: a dead machine login (401 → credentials cleared
    // + onSessionExpired), the terminal cap (429), or a network blip. Say so now — the
    // banner still reads "connected" (it only knows about the local credentials file),
    // so staying silent leaves the user to discover it as a bare "No API key found for
    // privateer" on their first prompt.
    const c = ctx as SeedContext;
    if (opts.notify !== false && c?.hasUI) {
      c.ui?.notify?.(`Privateer account channel unavailable — ${(e as Error).message}`, "error");
    }
    return false;
  }
}
