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
  currentUser,
  logout,
  runDeviceLogin,
  authedFetch,
  acquireAccountCredential,
  refreshAccountCredentials,
  notifySignedIn,
} from "../auth/privateer.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalDir } from "../config/paths.ts";
import { canOpenBrowser, openInBrowser } from "../util/openBrowser.ts";
import { interpretReport, teePosture, tierFromTeePosture, type PrivacyTier } from "pi-privacy";
import { ACCOUNT_DEFAULT_MODEL_ID, ACCOUNT_NEAR_MODEL_ID, ensurePiDefaultModel } from "./defaultModel.ts";
import { visionInput } from "./vision.ts";
import { piAuthStore } from "./piAuthStore.ts";
import {
  sealedEnabled,
  sealedProviderFor,
  sealedShimBase,
  ensureSealedShim,
  attestSealed,
} from "./sealedShim.ts";
import type { PhalaEnclaveIdentity } from "./phalaSeal.ts";

// Seed/fallback catalog: registered synchronously so the account provider has real
// models the instant it loads (before the live /api/models fetch resolves) — in
// particular ACCOUNT_DEFAULT_MODEL_ID resolves at startup without a "model not
// found" warning, which matters more than ever now that a signed-OUT terminal also
// launches on it. The first two entries are the TEE tiers (Tinfoil, then NEAR); the
// rest are the familiar names. Also the fallback list if the live listing is
// unreachable. It is the FLOOR of the synchronous seed, not the whole of it — a launch
// that has seen the live catalog before seeds from the cache too (see seedCatalogIds).
const DEFAULT_MODELS = [
  ACCOUNT_DEFAULT_MODEL_ID,
  ACCOUNT_NEAR_MODEL_ID,
  // All three former defaults (see TINFOIL_MODEL_ID for the dates). They stay in the
  // floor so a user who saved any of them as their own default still resolves it
  // synchronously at launch, rather than falling through to "first model with
  // configured auth" — the BYO dead end this seed list exists to prevent.
  "tinfoil/gpt-oss-120b",
  "tinfoil/kimi-k2-6",
  "tinfoil/glm-5-2",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.6-sol",
  "deepseek/deepseek-v4-flash",
  // 2026-08 releases, confirmed live on OpenRouter (ZDR-covered ids reach the
  // account catalog automatically; these seeds just make them resolve at launch).
  "moonshotai/kimi-k3",
  "z-ai/glm-5.2",
  // Both verified 2026-08-19 against /endpoints/zdr and GET /api/models: ZDR-covered
  // and servable. Same reason as the line above — the live catalog already carries
  // them, this only closes the first-launch window where a saved default that isn't
  // yet in the cache would fall through to a BYO provider.
  "x-ai/grok-4.6",
  "openai/gpt-5.6-luna",
];

function seedModel(id: string) {
  return {
    id,
    name: id,
    // reasoning + how to steer it, for the enclave models where we verified the
    // control shape live; `reasoning: false` (Pi's "not a thinking model") for the rest.
    ...(thinkingProfile(id) ?? { reasoning: false as const }),
    // Honest modalities. This was hardcoded to text for the whole catalog, which made
    // Pi strip every image from every account request — including the ones `read`
    // attaches when the user points at a screenshot. See providers/vision.ts.
    input: visionInput(id),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

// ── Thinking control ─────────────────────────────────────────────────────────
//
// Every account model used to register with `reasoning: false`, and that one field
// silently pinned the whole catalog to maximum thinking. Pi gates EVERY
// thinking-control branch on `model.reasoning` (pi-ai api/openai-completions.js
// buildParams) and AgentSession.cycleThinkingLevel() returns undefined without it. So
// Privateer sent no thinking parameter at all — a thinking model ran at whatever its
// server-side default was, forever — and the user's thinking toggle was inert.
//
// What that cost, measured live against the account channel on 2026-08-01 with
// "Write a haiku about the sea": the default model emitted 77 reasoning deltas and
// ZERO content, spending all 300 tokens thinking. The same prompt with thinking off
// answered in 18 tokens / 1.8s.
//
// Annotating a model is a promise that the dial actually moves, so ONLY shapes
// verified against the live enclave appear below. Pi's default level is "medium", so
// nothing here turns thinking off behind the user's back — it makes the toggle real.
interface ThinkingProfile {
  reasoning: true;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: { thinkingFormat: string };
}

// The vLLM chat-template family (GLM, Qwen). Honours
// `chat_template_kwargs.enable_thinking`, which is exactly what Pi's
// "qwen-chat-template" format emits. Verified — enable_thinking=false → 0 reasoning
// deltas and a direct answer, true → thinking restored, neither errors — on
// tinfoil/glm-5-2, near/zai-org/GLM-5.1-FP8, near/Qwen/Qwen3.6-35B-A3B-FP8 and
// phala/z-ai/glm-5.2.
//
// The switch is binary (there is no effort dial), so publish exactly two levels
// instead of five that all mean "on": a null in thinkingLevelMap marks a level
// unsupported and pi-ai's getSupportedThinkingLevels drops it.
const CHAT_TEMPLATE_THINKING: ThinkingProfile = {
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: null, high: null, xhigh: null },
  compat: { thinkingFormat: "qwen-chat-template" },
};

// gpt-oss (harmony) is the other way round: it IGNORES chat_template_kwargs and
// honours `reasoning_effort` — which is Pi's default format for our baseUrl, so this
// profile deliberately carries no compat override. Verified on tinfoil/gpt-oss-120b:
// low → 9 reasoning deltas, high → 61.
//
// Harmony has no "none", so "off" is pinned to the floor rather than left unset —
// unset would send nothing and let the model fall back to its own default (medium),
// i.e. an "off" that thinks harder than "low". This is the toggle's lowest setting,
// not silence.
const REASONING_EFFORT_THINKING: ThinkingProfile = {
  reasoning: true,
  thinkingLevelMap: { off: "low", minimal: "low", xhigh: null },
};

// Only the TEE prefixes are annotated. Those are enclaves we drive directly and can
// probe. The rest of the catalog is proxied to a third-party gateway whose thinking
// shape we have NOT verified from here, and an unsupported parameter fails the whole
// turn — decisively worse than a turn that thinks too much. They keep the old
// behaviour exactly.
//
// Two deliberate omissions inside the TEE set: `*-instruct` ids are the
// non-thinking variants, and tinfoil/kimi-k2-6 reasons but ignored BOTH levers when
// probed, so annotating it would hand the user a dial connected to nothing.
const TEE_MODEL = /^(tinfoil|phala|near)\//;

export function thinkingProfile(id: string): ThinkingProfile | null {
  if (!TEE_MODEL.test(id)) return null;
  if (/instruct/i.test(id)) return null;
  const profile = /gpt-oss/i.test(id)
    ? REASONING_EFFORT_THINKING
    : /glm|qwen/i.test(id)
      ? CHAT_TEMPLATE_THINKING
      : null;
  // Hand out a COPY. These entries end up on hundreds of registered models, and a
  // shared nested object is one careless mutation away from retuning the whole catalog.
  return profile && { ...profile, thinkingLevelMap: { ...profile.thinkingLevelMap }, ...(profile.compat ? { compat: { ...profile.compat } } : {}) };
}

// ── Catalog cache ────────────────────────────────────────────────────────────
//
// The live catalog (241 models and counting) can only be registered once the network
// fetch resolves, and a registration made after extension load does NOT reach the model
// registry immediately: pi queues it (extensions/loader.js pendingProviderRegistrations)
// and flushes it when the session BINDS. Everything that resolves a model at LAUNCH runs
// before that — Pi's findInitialModel (saved settings default) and its session-model
// restore both call modelRegistry.find() while only the synchronous seed exists. So a
// model outside DEFAULT_MODELS was un-resolvable at launch and Pi fell through to "first
// model with configured auth", i.e. a BYO provider — measurably `openrouter/*` on a
// machine with an OpenRouter key. That is the dead end defaultModel.ts exists to prevent,
// re-entered through the back door.
//
// So: remember the ids the live catalog last returned, and seed from them SYNCHRONOUSLY
// on the next launch. The live fetch still re-registers the authoritative list moments
// later, so a model the server drops disappears on the next launch rather than lingering.
//
// Deliberately ids ONLY. Privacy tiers are never cached: the tier drives the shield in
// /models, and a stale privacy claim is exactly the thing not to render from disk. The
// picker keeps fetching them live (accountCatalogLoaded stays false until it does).
const CATALOG_CACHE_MAX = 2000; // bound what a corrupted/hostile file can register

function catalogCachePath(): string {
  return join(globalDir(), "account-models.json");
}

// Best effort in both directions: this cache is an optimization, and a launch must never
// fail because it couldn't be read or written.
function saveCachedCatalogIds(ids: string[]): void {
  try {
    mkdirSync(globalDir(), { recursive: true });
    const payload = { v: 1, fetchedAt: new Date().toISOString(), ids: ids.slice(0, CATALOG_CACHE_MAX) };
    writeFileSync(catalogCachePath(), JSON.stringify(payload) + "\n", "utf8");
  } catch {
    /* unwritable home — we just seed from DEFAULT_MODELS next launch */
  }
}

export function loadCachedCatalogIds(): string[] {
  try {
    const path = catalogCachePath();
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { ids?: unknown };
    if (!Array.isArray(parsed.ids)) return [];
    return parsed.ids.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, CATALOG_CACHE_MAX);
  } catch {
    return []; // absent, unreadable, or garbage — the seed list still works
  }
}

// Whether the account channel can actually SERVE a catalog model right now.
//
// `phala/*` is sealed-only: it runs through the sealed blind relay and nowhere else.
// The server's cleartext `/api/agent/v1` has no Phala route and rejects the id
// outright (verified live 2026-07-31: 400 "phala/… is not a valid model ID"), because
// Phala models are the Sealed tier by design — the server is not meant to be able to
// read them. But `/api/models` advertises them to every client regardless of whether
// that client can reach the sealed path, so they were pickable and then failed on the
// first prompt. Offering a model we know cannot answer is worse than a shorter list.
//
// The condition is the SHIM, not the flag. Sealed mode being enabled only means we
// intend to seal; `phala/*` is unservable until the loopback shim is actually
// listening, because that is what its per-model baseUrl points at (see modelEntry).
// With the flag now defaulting on, "enabled but the shim failed to bind" is a state a
// user can really land in, and it must not re-offer models that would 400.
//
// `tinfoil/*` is deliberately NOT filtered: the cleartext path serves it fine (sealed
// mode only upgrades the badge from unconfirmed to verified), so it stays either way.
export function isServableAccountModel(id: string): boolean {
  if (!id.startsWith("phala/")) return true;
  return sealedEnabled() && sealedShimBase() !== null;
}

// The ids to register synchronously at load. DEFAULT_MODELS FIRST and always: the account
// default has to be index 0 both because it must always resolve and because Pi clones the
// provider's first/default model when it synthesizes a custom model id
// (model-resolver.js buildFallbackModel).
//
// Returns the server's list as cached, unfiltered — accountProviderConfig decides what
// is servable at each registration, so a model dropped now (shim not up yet) can be
// re-offered by a later re-registration without the cache being rewritten.
export function seedCatalogIds(): string[] {
  const ids = [...DEFAULT_MODELS];
  const seen = new Set(ids);
  for (const id of loadCachedCatalogIds()) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
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
  return modelId.startsWith("near/") || modelId.startsWith("tinfoil/") || modelId.startsWith("phala/")
    ? "tee-unverified"
    : "standard";
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
      // Cache only a real LIVE listing — never the fallback, which would freeze the six
      // seed ids on disk and read back as though it were the catalog. Both the cache and
      // the returned list are the server's UNFILTERED offer; servability is decided at
      // registration (accountProviderConfig), which re-evaluates it every time.
      if (parsed.length) saveCachedCatalogIds(parsed.map((p) => p.id));
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

// The device-code verification link, as an ABSOLUTE url.
//
// The server sends it scheme-less ("www.privateer.pro/settings/link-terminal?code=…"),
// and both surfaces that show it treat it as a URL: Pi's login dialog wraps it in an
// OSC-8 terminal hyperlink, and our own /login widget prints it for the user to open.
// Without a scheme an OSC-8 target isn't a valid URI, so terminals decline to linkify
// it — the one link in the sign-in flow becomes unclickable text. Prefix https:// when
// the value has no scheme of its own, and leave a well-formed (or empty) value alone.
// Only http/https are honoured: a scheme-looking prefix we don't expect is treated as a
// hostname rather than passed through to a terminal as a clickable link.
export function verificationLink(raw: string | undefined): string {
  const uri = (raw ?? "").trim();
  if (!uri) return "";
  if (/^https?:\/\//i.test(uri)) return uri;
  return `https://${uri.replace(/^\/+/, "")}`;
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
  async login(cb: {
    onDeviceCode?: (info: unknown) => void;
    onSelect?: (prompt: { message: string; options: { id: string; label: string }[] }) => Promise<string | undefined>;
    signal?: AbortSignal;
  }) {
    // Fresh machine? The device-code flow below fires notifySignedIn itself (via
    // pollForToken). Already linked? No device code runs — so we announce the
    // completed subscription login ourselves at the end, or the header/badge would
    // keep showing "not signed in" until the next launch.
    //
    // Already linked AND the user wants a DIFFERENT account is the third case, and it
    // used to be unreachable: login() short-circuited on hasCredentials(), so choosing
    // "Privateer account" while linked silently re-armed the account already signed in
    // and reported success — there was no way to switch accounts from here at all. Pi
    // hands us an `onSelect` callback for exactly this, so ask. Switching means signing
    // this machine out first (logout revokes the machine's whole token family), which
    // the prompt says plainly; the device flow then runs as if fresh.
    let wasLinked = hasCredentials();
    if (wasLinked && cb.onSelect) {
      const user = currentUser();
      const who = user?.email ?? user?.id ?? "this account";
      const choice = await cb.onSelect({
        message: `Already signed in as ${who}.`,
        options: [
          { id: "keep", label: `Stay signed in as ${who}` },
          { id: "switch", label: "Sign in as a different account (signs this machine out first)" },
        ],
      });
      if (choice === undefined) throw new Error("Login cancelled"); // selector dismissed
      if (choice === "switch") {
        await logout(); // revokes this machine's sessions and wipes local auth state
        wasLinked = false; // fall through to the device flow as a fresh machine
      }
    }
    if (!wasLinked) {
      try {
        await runDeviceLogin({
          signal: cb.signal,
          onCode: (code) => {
            // Absolute url — the server's value is scheme-less and Pi renders this as
            // a terminal hyperlink. See verificationLink.
            const uri = verificationLink(code.verification_uri_complete ?? code.verification_uri);
            // Browser-first: the URL carries the code, so the page lands on the
            // Authorize screen and the user just clicks. Best-effort fire-and-forget —
            // Pi's dialog keeps showing the code + link as the fallback either way.
            if (uri && canOpenBrowser()) void openInBrowser(uri);
            cb.onDeviceCode?.({
              userCode: code.user_code,
              verificationUri: uri,
              intervalSeconds: code.interval,
              expiresInSeconds: code.expires_in,
            });
          },
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
    // Rotate THIS process's own session, never another terminal's. Pi keeps one
    // credential per provider in auth.json and that file is machine-global, so the
    // credential handed to us here can belong to a different, still-running terminal
    // (see the ownership note above rememberAccountCredential). Rotating that one
    // would take over its session and invalidate the copy it still holds — the exact
    // reuse hazard the child-session split exists to avoid (auth/privateer.ts). When
    // the incoming token isn't ours, rotate ours instead: Pi gets a valid credential
    // either way, and the other terminal keeps its own.
    const mine = armSlot().cred?.refresh;
    const refresh = mine && creds.refresh !== mine ? mine : creds.refresh;
    let next: AccountCredential;
    try {
      next = await refreshAccountCredentials(refresh);
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
// out of a TEE. `near/` is the one we can attest in full from here (the server
// proxies a nonce'd quote); `tinfoil/` and `phala/` are equally real enclaves whose
// attestation we cannot bind to THIS connection through the proxy — see accountPosture.
const TEE_PREFIXES = ["near/", "tinfoil/", "phala/"];

// Which privacy channel an account model routes through: confidential compute (TEE)
// for the prefixes above, else a server-side ZDR channel. Ported from tree-cli
// resolve.ts, then widened — it used to say `near/` only, which quietly labelled the
// then-default model (tinfoil/glm-5-2, a TEE model) as a mere ZDR policy claim.
export function privateerChannel(modelId: string): "tee" | "zdr" {
  return TEE_PREFIXES.some((p) => modelId.startsWith(p)) ? "tee" : "zdr";
}

export interface AccountPosture {
  tier: PrivacyTier;
  teePosture?: "green" | "yellow" | "red";
  error?: string;
  // Phala sealed path only: what the verified quote says about the enclave that
  // answered. Evidence about WHICH image it was, not part of the verdict — the tier
  // above is decided by the crypto binding + quote alone. See phalaSeal.ts.
  enclaveIdentity?: PhalaEnclaveIdentity;
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
    return att.ok
      ? { tier: "tee-verified", enclaveIdentity: att.enclaveIdentity }
      : { tier: "tee-unverified", error: att.error };
  }
  // Honest labelling for the non-NEAR enclaves when we are NOT sealing — sealed mode
  // explicitly disabled (PRIVATEER_SEALED=0), or on but the shim never came up. Tinfoil
  // and Phala publish real attestations, but the server proxies the inference in
  // cleartext, so from here we cannot bind a quote to the connection actually carrying
  // our tokens — only the account's word that it did. That's `tee-unverified` (yellow
  // "confidential compute, unconfirmed"), never the green tee-verified we reserve for a
  // quote we checked ourselves. Re-enable sealed mode for the verified shield, or set
  // TINFOIL_API_KEY and run `tinfoil/*` direct (pi-privacy attests client-side over the
  // TLS binding).
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

// A model entry, with a per-model baseUrl override once the sealed shim is listening:
// `tinfoil/*` and `phala/*` then route through the loopback shim (which seals to the
// blind relay) instead of the cleartext `/api/agent/v1` proxy. Everything else keeps the
// provider baseUrl. Until the shim is up (or with sealed mode disabled) `tinfoil/*` falls
// back to the cleartext path and the badge stays honestly `tee-unverified` (see
// accountPosture); `phala/*` has no cleartext path at all and is not registered in that
// state (see isServableAccountModel).
function modelEntry(id: string) {
  const base = seedModel(id);
  const provider = sealedEnabled() ? sealedProviderFor(id) : null;
  const shim = sealedShimBase();
  return provider && shim ? { ...base, baseUrl: `${shim}/${provider}/v1` } : base;
}

// The Pi provider config for the account channel, over a given set of model ids.
export function accountProviderConfig(ids: string[]): Record<string, unknown> {
  return {
    name: "Privateer account",
    baseUrl: `${serverBaseUrl()}/api/agent/v1`,
    api: "openai-completions",
    oauth: privateerOAuthProvider,
    // Filter HERE rather than at the catalog, so callers keep passing the server's
    // full list and every registration re-evaluates servability against the CURRENT
    // shim state. That is what lets the post-shim re-registration in makeAccountProvider
    // put `phala/*` back: had the ids been filtered upstream, the sealed-only models
    // would have been dropped from `lastIds` before the shim ever finished starting and
    // nothing would have brought them back.
    models: ids.filter(isServableAccountModel).map(modelEntry),
  };
}

// Re-assert the account channel's registration from ANOTHER extension.
//
// pi-privacy also ships a `privateer` provider (its PRIVACY_PROVIDERS catalog) — the
// PUBLIC developer-key channel: baseUrl api.privateer.pro/v1, `${PRIVATEER_API_KEY}`,
// and a single seed model (near/zai-org/GLM-5.1-FP8). Pi's registerProvider FULLY
// REPLACES a provider's model list and its request config, so whichever registration
// lands last wins — and pi extensions are discovered with an unsorted readdirSync, which
// on a typical box puts privateer-privacy after privateer-account. The account channel's
// whole catalog was then replaced by that one model, so the account default no
// longer resolved ("not found for provider privateer. Using custom model id") and the
// synthesized model inherited the PUBLIC endpoint instead of `/api/agent/v1`.
//
// So privateer-privacy.ts calls this right after pi-privacy runs, exactly as it re-widens
// `tinfoil`. Idempotent and order-independent: if privacy happens to load first, the
// account extension's own registration lands afterwards with the same config, and the
// live-catalog fetch re-registers over both moments later either way.
export function registerAccountModels(pi: {
  registerProvider?: (name: string, config: unknown) => void;
}): void {
  pi.registerProvider?.("privateer", accountProviderConfig(seedCatalogIds()));
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
    // Seed with the last live catalog when we have one (see seedCatalogIds): this is the
    // list Pi resolves a saved default / a restored session model against at launch,
    // before the live re-registration can reach the registry.
    let lastIds: string[] = seedCatalogIds();
    const register = (ids: string[]): void => {
      lastIds = ids;
      pi.registerProvider!("privateer", accountProviderConfig(ids));
    };
    register(lastIds); // immediate: provider exists this tick, with a resolvable catalog
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

    // Two safety nets around the account channel, both OUTSIDE the request path —
    // they read Pi's in-memory auth map and its finished messages, and never touch the
    // inference request itself, so a healthy prompt behaves exactly as before.
    //
    // before_agent_start: re-arm if Pi's persisted credential vanished mid-session.
    // Awaited (Pi awaits extension handlers), so the turn starts with a key rather than
    // failing and asking the user to resend. See ensureAccountArmed.
    pi.on?.("before_agent_start", async (_e, ctx) => {
      try {
        await ensureAccountArmed(ctx);
      } catch {
        /* the turn's own error path reports better than a diagnostic here */
      }
    });

    // message_end: an assistant turn that ended in an auth error on the account channel
    // means our session token is dead server-side. Pi has no reactive-401 refresh, so
    // replace the session now instead of failing every prompt until `expires`.
    // See recoverAccountSession.
    pi.on?.("message_end", (e, ctx) => {
      const msg = (e as { message?: { role?: string; stopReason?: string; errorMessage?: string } })?.message;
      if (msg?.role !== "assistant" || msg.stopReason !== "error" || !msg.errorMessage) return;
      if ((ctx as SeedContext)?.model?.provider !== "privateer") return;
      void recoverAccountSession(ctx, msg.errorMessage);
    });
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
  [ARMED]?: {
    cred?: AccountCredential;
    inFlight?: Promise<AccountCredential>;
    // When we last replaced a failed session (recoverAccountSession's cooldown).
    recoveredAt?: number;
  };
};

function armSlot(): NonNullable<ArmedSlot[typeof ARMED]> {
  const g = globalThis as ArmedSlot;
  return (g[ARMED] ??= {});
}

// Record a credential this process minted so nothing mints a second one. Exported for
// the OAuth login path, which acquires its credential for Pi to own and would
// otherwise leave the next arm() with nothing to reuse.
//
// This memo is also the OWNERSHIP record for Pi's persisted credential, which matters
// because auth.json holds exactly one `privateer` entry and is shared by every
// Privateer terminal on the machine. Each terminal mints its own session at launch, so
// the last one to start wins on disk and the entry any terminal reads back may belong
// to a different, still-running terminal. Two rules follow, both keyed off this memo:
//
//   1. Only DROP the persisted entry when it's the one we minted
//      (dropPersistedAccountCredential). The exit hooks used to remove it
//      unconditionally, so quitting one terminal deleted a live terminal's credential.
//      That terminal kept working from Pi's in-memory copy until `expires`, then Pi
//      reloaded auth.json, found nothing, and every prompt dead-ended on "No API key
//      found for privateer" — with nothing to re-arm it before the next session_start.
//   2. Only ROTATE our own refresh token (privateerOAuthProvider.refreshToken).
export function rememberAccountCredential(cred: AccountCredential): void {
  armSlot().cred = cred;
}

// The credential this process minted, if any. Ownership probe for the two rules above.
export function ownedAccountCredential(): AccountCredential | undefined {
  return armSlot().cred;
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

// `ctx` is Pi's ExtensionContext. It used to carry the auth store too
// (ctx.modelRegistry.authStorage) — pi 0.84 removed it, and the surviving
// ModelRegistry facade has no credential surface at all, so the store is resolved
// from piAuthStore() instead and `ctx` is now only ever consulted for UI.
type SeedContext = {
  model?: { provider?: string; id?: string };
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
  try {
    // `modify` is the store's only write path: it hands us the current entry and
    // takes the replacement back. We ignore the current one — a freshly minted
    // child credential always supersedes whatever is on disk.
    const cred = await accountCredential();
    await (await piAuthStore()).modify("privateer", async () => ({ type: "oauth", ...cred }));
    return true;
  } catch (e) {
    // The account channel is NOT armed: a dead machine login (401 → credentials cleared
    // + onSessionExpired), the terminal cap (429), or a network blip. Say so now — the
    // banner still reads "connected" (it only knows about the local credentials file),
    // so staying silent leaves the user to discover it as a bare "No API key found for
    // privateer" on their first prompt.
    const c = ctx as SeedContext;
    // If the credentials vanished during the call, the spawn hit a 401 and
    // onSessionExpired already announced the sign-out — a second line here would
    // just repeat it (we returned early above if we STARTED signed out).
    if (opts.notify !== false && c?.hasUI && hasCredentials()) {
      c.ui?.notify?.(`Privateer account channel unavailable — ${(e as Error).message}`, "error");
    }
    return false;
  }
}

// Write an already-acquired account credential into Pi's auth store.
//
// The entrypoints that mint their own child credential (chat, acp, harbor, the live
// task session) used to poke `services.authStorage.set(...)` directly. pi 0.84 removed
// that property and made the store's only write path an async `modify`, so the poke
// lives here now — one place that knows the shape, next to the ownership rules that
// govern the same entry.
export async function persistAccountCredential(creds: AccountCredential): Promise<void> {
  await (await piAuthStore()).modify("privateer", async () => ({ type: "oauth", ...creds }));
}

// Drop Pi's PERSISTED account credential (the `privateer` entry in auth.json) — but
// ONLY when it's the one this process minted. Every exit path pairs a session revoke
// with this drop (the contract in auth/privateer.ts): Pi reuses the persisted
// credential on the next launch and refreshes it only on expiry, never reactively on a
// 401, so leaving a revoked token behind dead-ends the next run.
//
// The ownership check is what keeps that teardown from harming a CONCURRENT terminal.
// auth.json is machine-global with one entry per provider, so the entry on disk is
// whichever terminal armed last; an unconditional remove here deleted a live
// terminal's key and stranded it (see the note above rememberAccountCredential).
// Returns true only if the entry was actually removed.
//
// `force` is for the teardowns where ownership is irrelevant because NOTHING on this
// machine can use the entry any more: an explicit sign-out and a detected
// expiry/revocation both go through logout()/clearCredentials(), which revoke the
// machine's whole token family — every terminal's session included. Those callers have
// also already wiped the local credentials, so the ownership memo is gone by then and an
// ownership-checked drop would refuse and strand a dead entry on disk.
export async function dropPersistedAccountCredential(
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const store = await piAuthStore();
  const mine = ownedAccountCredential()?.access;
  // Every caller revokes this process's session immediately before calling us, so drop
  // the memo whatever happens to the entry on disk — otherwise a later arm() in this
  // process (a harbor run's session_start, say) could re-persist the revoked token.
  armSlot().cred = undefined;
  try {
    if (!opts.force) {
      // Not force: read the entry back and only drop it if it is ours. This read is
      // the whole safety property — it is what sees the entry a CONCURRENT terminal
      // wrote, and auth.json is re-read from disk when its revision changes, so this
      // observes other processes rather than a stale in-process copy.
      const persisted = (await store.read("privateer")) as { access?: unknown } | undefined;
      if (!persisted) return false; // nothing persisted — nothing to drop
      // Some other terminal's session. Leave it: it's the key that terminal is using.
      if (typeof persisted.access === "string" && persisted.access !== mine) return false;
    }
    // force: the whole token family is revoked, so the entry is dead for every
    // terminal and ownership is irrelevant.
    await store.delete("privateer");
    return true;
  } catch {
    return false; // unwritable store — the server TTL is the fallback
  }
}

// Make sure Pi still HAS an account credential before a turn goes out. Normally
// session_start's arm is enough and this is a free in-memory lookup. It exists for the
// case session_start can't cover: the persisted entry disappearing mid-session, which
// another terminal's exit could do (and still can, for a terminal running an older
// build without the ownership check above). Once the entry is gone Pi has no path back
// — getApiKey returns undefined and nothing re-arms until the next session_start — so
// every prompt fails on "No API key found for privateer".
//
// An entry that exists but has EXPIRED is deliberately left alone: that's Pi's own
// refresh path (refreshToken), and pre-empting it would mint a second session row.
export async function ensureAccountArmed(ctx: unknown): Promise<void> {
  if (!hasCredentials()) return;
  try {
    if (await (await piAuthStore()).read("privateer")) return;
  } catch {
    return; // can't tell — leave it to the next session_start
  }
  await armAccountCredential(ctx, { notify: false });
}

// Errors that mean "the token we're presenting is no longer accepted", as opposed to a
// cap, a network blip, or a model error. Matched against the provider error text Pi
// surfaces (the OpenAI SDK prefixes the status, and our backend sends `code` +
// `message`), so a revoked or dead session is recognizable without parsing internals.
// "No API key ... privateer" covers both wordings that mean the channel wasn't armed:
// pi-ai's "No API key for provider: privateer" (thrown when getApiKey resolves to
// undefined, which is also what a swallowed refresh failure looks like — pi-ai flattens
// our reason into "Failed to refresh OAuth token") and Pi's own "No API key found for
// privateer." guidance text.
const ACCOUNT_AUTH_FAILURE =
  /\b401\b|SESSION_REVOKED|Authentication required|Invalid token|Failed to refresh OAuth token|No API key\b[^\n]*privateer/i;

// Don't spin: if the account itself is gone, one replacement attempt per window is
// plenty, and the user gets a clear message instead of a retry loop.
const RECOVERY_COOLDOWN_MS = 30_000;

// Replace a dead account session after an auth failure, so the NEXT prompt works.
//
// This is the client-side answer to a gap in Pi's OAuth contract: inference goes out
// over Pi's own HTTP path (provider baseUrl + the bearer from getApiKey), which has no
// reactive-401 hook — unlike authedFetch, which refreshes and retries in place. Pi
// refreshes on `expires` alone, so a session that dies server-side early (revoked from
// the app's Linked Devices, or cascaded by another device's logout) stays dead for the
// remaining lifetime of the access token — up to ~24h — with every prompt failing.
// Detecting the failure after the fact and re-arming turns that into a single failed
// turn the user can resend.
export async function recoverAccountSession(ctx: unknown, errorMessage: string): Promise<boolean> {
  if (!hasCredentials()) return false; // signed out: onSessionExpired owns that message
  if (!ACCOUNT_AUTH_FAILURE.test(errorMessage)) return false;
  const slot = armSlot();
  const now = Date.now();
  if (slot.recoveredAt !== undefined && now - slot.recoveredAt < RECOVERY_COOLDOWN_MS) return false;
  slot.recoveredAt = now;
  // The credential we hold is the one that just failed — forget it so the arm below
  // reclaims or spawns a live session instead of handing back the dead token.
  slot.cred = undefined;
  const armed = await armAccountCredential(ctx, { notify: false });
  const c = ctx as SeedContext;
  if (c?.hasUI) {
    c.ui?.notify?.(
      armed
        ? "Your Privateer account session had expired — opened a new one. Send that message again."
        : "Your Privateer account session isn't valid any more and couldn't be renewed. Run /login to sign back in.",
      armed ? "warning" : "error",
    );
  }
  return armed;
}
