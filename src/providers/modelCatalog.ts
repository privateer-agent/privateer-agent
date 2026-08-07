// What the `/model` picker is allowed to offer, and why it might be short.
//
// Three surfaces build that list — the REPL (`cli/chat.ts`), the desktop session
// (`desktop/src/main/agentSession.ts`) and, through the relay, the app's picker
// sheet — and all three used the same two lines: `modelRegistry.getAvailable()`,
// mapped to `provider/id` and sorted. Two things about that list are surprising
// enough that they belong here rather than being rediscovered at each call site:
//
//  1. **Sealed-only models are registered late.** `phala/*` is registered only once
//     the sealed loopback shim is bound (isServableAccountModel — the cleartext
//     `/api/agent/v1` has no Phala route and rejects those ids outright), and the
//     shim binds a beat AFTER the session's first synchronous registration. The
//     account provider re-registers when it comes up, so the catalog heals itself
//     within ~half a second — but a picker opened inside that window listed a
//     catalog quietly missing the whole Phala tier. Waiting for the shim first
//     costs milliseconds (`startShim` is a loopback `listen(0)` — no network and no
//     attestation) and removes the race.
//
//  2. **The account catalog can be registered and yet entirely unavailable.** Pi's
//     `getAvailable()` is `models.filter(hasConfiguredAuth)`, and hasConfiguredAuth
//     is "the provider has an auth entry, or its config's apiKey resolves". The
//     account provider has no apiKey — it authenticates with an OAuth child token —
//     so every `privateer/*` model (the NEAR and Tinfoil confidential tiers, and the
//     bulk of the 240-odd catalog) is filtered out until the credential is armed
//     into Pi's auth store, which needs a machine login. On a signed-out box the
//     picker therefore drops the entire account catalog and says nothing: it looks
//     like we don't carry those models, rather than like you're signed out.
//
// So: one place computes the list, and the same place reports what it had to hide.

import { hasCredentials } from "../auth/privateer.ts";
import { ensureSealedShim, sealedEnabled, sealedShimBase } from "./sealedShim.ts";

/** The routing provider for the account channel — `privateer/<catalog id>`. */
export const ACCOUNT_PROVIDER = "privateer";

/** The shape we need from Pi's model registry (kept structural — it's untyped here). */
export interface CatalogRegistry {
  getAll?: () => unknown[];
  getAvailable?: () => unknown[] | Promise<unknown[]>;
}

interface RegistryModel {
  provider?: string;
  id?: string;
}

const specOf = (m: RegistryModel): string => `${m.provider}/${m.id}`;

/**
 * Wait for the sealed shim if it's coming, so a catalog read can't miss the
 * sealed-only models purely because it happened early (see note 1 above).
 *
 * The account provider attached its own post-shim re-registration at extension
 * init, i.e. BEFORE this one — promise callbacks run in attachment order, so by the
 * time this resolves, `phala/*` is already in the registry. Failure is not fatal:
 * the catalog is then honestly the one we can serve.
 */
export async function readySealedCatalog(): Promise<void> {
  if (!sealedEnabled() || sealedShimBase()) return;
  try {
    await ensureSealedShim();
  } catch {
    /* no shim → no sealed models, which is exactly what the list should show */
  }
}

export interface PickerCatalog {
  /** Sorted `provider/id` specs the session can actually reach — what to offer. */
  specs: string[];
  /** Account models registered but unreachable right now (0 when all is well). */
  hiddenAccountModels: number;
  /** Whether this machine holds a Privateer login at all. */
  signedIn: boolean;
}

/** The picker's list, plus what it had to leave out. */
export async function pickerCatalog(registry: CatalogRegistry | null | undefined): Promise<PickerCatalog> {
  await readySealedCatalog();
  const available = ((await registry?.getAvailable?.()) ?? []) as RegistryModel[];
  const all = (registry?.getAll?.() ?? []) as RegistryModel[];
  const offeredAccount = available.filter((m) => m.provider === ACCOUNT_PROVIDER).length;
  const registeredAccount = all.filter((m) => m.provider === ACCOUNT_PROVIDER).length;
  return {
    specs: available.map(specOf).sort(),
    hiddenAccountModels: Math.max(0, registeredAccount - offeredAccount),
    signedIn: hasCredentials(),
  };
}

/**
 * One line explaining an account catalog we registered but can't offer, or null
 * when there's nothing to explain.
 *
 * `signInHint` is the caller's own instruction for getting signed in — the REPL
 * says `/login`, the desktop points at its Account menu — because "sign in" without
 * saying where is the half of this message that was already implicit.
 */
export function hiddenAccountNotice(cat: PickerCatalog, signInHint: string): string | null {
  if (cat.hiddenAccountModels === 0) return null;
  const n = cat.hiddenAccountModels;
  const models = `${n} Privateer account model${n === 1 ? "" : "s"} (including the confidential TEE ones)`;
  return cat.signedIn
    // Signed in but still unavailable: the credential never reached Pi's auth store
    // — a revoked machine login, the terminal cap, or a network blip while arming.
    ? `${models} are hidden — the account channel isn't armed. ${signInHint}`
    : `Not signed in — ${models} are hidden. ${signInHint}`;
}

/** A short suffix for the picker's own title, so the shortfall shows where you're looking. */
export function hiddenAccountTitleSuffix(cat: PickerCatalog): string {
  return cat.hiddenAccountModels === 0
    ? ""
    : ` · sign in for ${cat.hiddenAccountModels} more`;
}
