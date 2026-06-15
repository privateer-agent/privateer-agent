import { useEffect, useState } from "react";
import type { Config } from "../config/schema.ts";
import { parseModelSpec } from "../providers/resolve.ts";
import { fetchAttestation, teePosture, type Attestation, type TeePosture } from "../providers/attestation.ts";

// What the status-bar shield should render for NEAR AI's TEE attestation. Distinct
// from posture so a dim "needs a key / unknown" affordance never implies a verdict.
export type TeeState =
  | { kind: "hidden" } // not a NEAR AI model — no badge
  | { kind: "no-key" } // NEAR AI selected but no API key to attest with
  | { kind: "loading" } // fetching the attestation report
  | { kind: "error" } // network / timeout / HTTP failure
  | { kind: "ready"; posture: TeePosture; attestation: Attestation };

// Attestations are per-model (each model has its own enclave + signing key), so we
// cache the in-flight/resolved promise per (apiKey, baseURL, modelId) and reuse it
// for the session. Concurrent consumers dedupe to one fetch; a rejection is evicted
// so a later selection can retry rather than being stuck in error forever.
const cache = new Map<string, Promise<Attestation>>();

function loadAttestation(apiKey: string, baseURL: string | undefined, modelId: string): Promise<Attestation> {
  const key = `${apiKey}::${baseURL ?? ""}::${modelId}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = fetchAttestation({ apiKey, baseURL }, modelId).catch((err) => {
      cache.delete(key);
      throw err;
    });
    cache.set(key, pending);
  }
  return pending;
}

// Resolve the TEE shield state for the currently selected model. Only NEAR AI
// models trigger a fetch; everything else returns "hidden" before touching the network.
export function useTeeShield(modelSpec: string, config: Config): TeeState {
  let provider = "";
  let modelId = "";
  try {
    ({ provider, modelId } = parseModelSpec(modelSpec));
  } catch {
    provider = "";
    modelId = "";
  }
  const cfg = config.providers.nearai ?? {};
  const apiKey = provider === "nearai" ? cfg.apiKey : undefined;
  const baseURL = cfg.baseURL;

  const [state, setState] = useState<TeeState>({ kind: "hidden" });

  useEffect(() => {
    if (provider !== "nearai") {
      setState({ kind: "hidden" });
      return;
    }
    if (!apiKey) {
      setState({ kind: "no-key" });
      return;
    }
    let ignore = false;
    setState({ kind: "loading" });
    loadAttestation(apiKey, baseURL, modelId)
      .then((attestation) => {
        if (!ignore) setState({ kind: "ready", posture: teePosture(attestation), attestation });
      })
      .catch(() => {
        if (!ignore) setState({ kind: "error" });
      });
    return () => {
      ignore = true;
    };
  }, [provider, apiKey, baseURL, modelId]);

  return state;
}
