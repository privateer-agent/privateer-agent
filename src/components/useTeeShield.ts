import { useEffect, useState } from "react";
import type { Config } from "../config/schema.ts";
import { parseModelSpec, privateerChannel } from "../providers/resolve.ts";
import {
  fetchAttestation,
  fetchAttestationViaServer,
  teePosture,
  type Attestation,
  type TeePosture,
} from "../providers/attestation.ts";

// What the status-bar shield should render for a TEE attestation. Distinct from
// posture so a dim "needs a key / unknown" affordance never implies a verdict.
export type TeeState =
  | { kind: "hidden" } // not a TEE-backed model — no badge
  | { kind: "no-key" } // NEAR AI (BYO key) selected but no API key to attest with
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

// Account-billed `privateer:near/*` models attest through the Privateer server
// proxy (the NEAR key stays server-side), so they cache by model id alone.
const serverCache = new Map<string, Promise<Attestation>>();

function loadServerAttestation(modelId: string): Promise<Attestation> {
  let pending = serverCache.get(modelId);
  if (!pending) {
    pending = fetchAttestationViaServer(modelId).catch((err) => {
      serverCache.delete(modelId);
      throw err;
    });
    serverCache.set(modelId, pending);
  }
  return pending;
}

// Resolve the TEE shield state for the currently selected model. Two paths trigger
// a fetch: BYO `nearai:*` models (direct gateway, needs a key) and account-billed
// `privateer:near/*` models (server proxy, uses the logged-in session). Everything
// else returns "hidden" before touching the network.
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
  const isNearai = provider === "nearai";
  const isPrivateerTee = provider === "privateer" && privateerChannel(modelId) === "tee";
  const apiKey = isNearai ? cfg.apiKey : undefined;
  const baseURL = cfg.baseURL;

  const [state, setState] = useState<TeeState>({ kind: "hidden" });

  useEffect(() => {
    if (!isNearai && !isPrivateerTee) {
      setState({ kind: "hidden" });
      return;
    }
    if (isNearai && !apiKey) {
      setState({ kind: "no-key" });
      return;
    }
    let ignore = false;
    setState({ kind: "loading" });
    const pending = isPrivateerTee
      ? loadServerAttestation(modelId)
      : loadAttestation(apiKey!, baseURL, modelId);
    pending
      .then((attestation) => {
        if (!ignore) setState({ kind: "ready", posture: teePosture(attestation), attestation });
      })
      .catch(() => {
        if (!ignore) setState({ kind: "error" });
      });
    return () => {
      ignore = true;
    };
  }, [isNearai, isPrivateerTee, apiKey, baseURL, modelId]);

  return state;
}
