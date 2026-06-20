import { useEffect, useState } from "react";
import type { Config, ProviderName } from "../config/schema.ts";
import { parseModelSpec, privateerChannel } from "../providers/resolve.ts";
import { fetchZdrAccount, zdrPosture, type ZdrAccountData, type ZdrPosture } from "../providers/models.ts";

// What the status-bar shield should render. Distinct from posture so we can show a
// dim "needs a key / unknown" affordance without ever implying a colored verdict.
export type ZdrState =
  | { kind: "hidden" } // not a ZDR-backed model — no badge
  | { kind: "no-key" } // OpenRouter selected but no API key to query with
  | { kind: "loading" } // fetching the account snapshot
  | { kind: "error" } // network / timeout / HTTP failure
  | { kind: "ready"; posture: ZdrPosture };

// The ZDR snapshot (Z, U, enforcement) is global per account, not per model, so we
// fetch it once per (apiKey, baseURL) and reuse it for the whole session — switching
// models re-evaluates synchronously. The cache holds the in-flight/resolved promise so
// concurrent consumers dedupe to a single fetch pair; a rejection is evicted so a later
// selection can retry rather than being stuck in error forever.
const cache = new Map<string, Promise<ZdrAccountData>>();

function loadAccount(apiKey: string, baseURL: string | undefined): Promise<ZdrAccountData> {
  const key = `${apiKey}::${baseURL ?? ""}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = fetchZdrAccount({ apiKey, baseURL }).catch((err) => {
      cache.delete(key);
      throw err;
    });
    cache.set(key, pending);
  }
  return pending;
}

// Resolve the ZDR shield state for the currently selected model. Only OpenRouter
// models trigger a fetch; everything else returns "hidden" before touching the network.
export function useZdrShield(modelSpec: string, config: Config): ZdrState {
  let provider = "";
  let modelId = "";
  try {
    ({ provider, modelId } = parseModelSpec(modelSpec));
  } catch {
    provider = "";
    modelId = "";
  }
  const cfg = config.providers.openrouter ?? {};
  const isOpenRouter = provider === "openrouter";
  // Account-billed Privateer models that aren't NEAR/TEE route through the server's
  // ZDR-pinned OpenRouter proxy — zero retention is guaranteed server-side.
  const isPrivateerZdr = provider === "privateer" && privateerChannel(modelId) === "zdr";
  const apiKey = isOpenRouter ? cfg.apiKey : undefined;
  const baseURL = cfg.baseURL;
  const enforced = Boolean(cfg.enforceZdr);

  const [state, setState] = useState<ZdrState>({ kind: "hidden" });

  useEffect(() => {
    if (isPrivateerZdr) {
      // The proxy always pins ZDR endpoints, so the posture is green without a
      // client-side account query (there's no OpenRouter key on this side).
      setState({ kind: "ready", posture: "green" });
      return;
    }
    if (!isOpenRouter) {
      setState({ kind: "hidden" });
      return;
    }
    if (!apiKey) {
      setState({ kind: "no-key" });
      return;
    }
    let ignore = false;
    setState({ kind: "loading" });
    loadAccount(apiKey, baseURL)
      .then((acct) => {
        if (!ignore) setState({ kind: "ready", posture: zdrPosture(modelId, acct, enforced) });
      })
      .catch(() => {
        if (!ignore) setState({ kind: "error" });
      });
    return () => {
      ignore = true;
    };
  }, [isOpenRouter, isPrivateerZdr, apiKey, baseURL, modelId, enforced]);

  return state;
}

// The account snapshot itself, for callers that score many models at once (the
// OpenRouter model picker renders a per-row badge). Same fetch + cache as the
// shield, but it hands back the raw ZdrAccountData so the consumer can call
// zdrPosture(id, account) for each model synchronously, without a fetch per row.
export type ZdrAccountState =
  | { kind: "idle" } // not OpenRouter, or no key — no badges
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; account: ZdrAccountData };

export function useZdrAccount(provider: ProviderName | string, config: Config): ZdrAccountState {
  const cfg = config.providers.openrouter ?? {};
  const apiKey = provider === "openrouter" ? cfg.apiKey : undefined;
  const baseURL = cfg.baseURL;

  const [state, setState] = useState<ZdrAccountState>({ kind: "idle" });

  useEffect(() => {
    if (provider !== "openrouter" || !apiKey) {
      setState({ kind: "idle" });
      return;
    }
    let ignore = false;
    setState({ kind: "loading" });
    loadAccount(apiKey, baseURL)
      .then((account) => {
        if (!ignore) setState({ kind: "ready", account });
      })
      .catch(() => {
        if (!ignore) setState({ kind: "error" });
      });
    return () => {
      ignore = true;
    };
  }, [provider, apiKey, baseURL]);

  return state;
}
