import { useEffect, useState } from "react";
import type { Config } from "../config/schema.ts";
import { parseModelSpec, privateerChannel } from "../providers/resolve.ts";
import {
  fetchAttestation,
  fetchAttestationViaServer,
  fetchTinfoilAttestation,
  teePosture,
  tinfoilTeePosture,
  type Attestation,
  type TinfoilAttestation,
  type TeePosture,
} from "../providers/attestation.ts";

// What the status-bar shield should render for a TEE attestation. Distinct from
// posture so a dim "needs a key / unknown" affordance never implies a verdict.
export type TeeState =
  | { kind: "hidden" } // not a TEE-backed model — no badge
  | { kind: "no-key" } // NEAR AI (BYO key) selected but no API key to attest with
  | { kind: "loading" } // fetching the attestation report
  | { kind: "error" } // network / timeout / HTTP failure
  | { kind: "ready"; posture: TeePosture; attestation: Attestation | TinfoilAttestation };

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

// Tinfoil attests the host itself (every model behind the gateway shares the
// enclave-terminated channel), and its well-known endpoint needs no key — so the
// cache is per endpoint, keyed by the configured baseURL.
const tinfoilCache = new Map<string, Promise<TinfoilAttestation>>();

function loadTinfoilAttestation(baseURL: string | undefined): Promise<TinfoilAttestation> {
  const key = baseURL ?? "";
  let pending = tinfoilCache.get(key);
  if (!pending) {
    pending = fetchTinfoilAttestation({ baseURL }).catch((err) => {
      tinfoilCache.delete(key);
      throw err;
    });
    tinfoilCache.set(key, pending);
  }
  return pending;
}

// Resolve the TEE shield state for the currently selected model. Three paths
// trigger a fetch: BYO `nearai:*` models (direct gateway, needs a key),
// account-billed `privateer:near/*` models (server proxy, uses the logged-in
// session), and `tinfoil:*` models (public per-host attestation document).
// Everything else returns "hidden" before touching the network.
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
  const isTinfoil = provider === "tinfoil";
  const apiKey = isNearai ? cfg.apiKey : undefined;
  const baseURL = cfg.baseURL;
  const tinfoilBaseURL = config.providers.tinfoil?.baseURL;

  const [state, setState] = useState<TeeState>({ kind: "hidden" });

  useEffect(() => {
    if (!isNearai && !isPrivateerTee && !isTinfoil) {
      setState({ kind: "hidden" });
      return;
    }
    if (isNearai && !apiKey) {
      setState({ kind: "no-key" });
      return;
    }
    let ignore = false;
    setState({ kind: "loading" });
    const pending: Promise<{ posture: TeePosture; attestation: Attestation | TinfoilAttestation }> =
      isTinfoil
        ? loadTinfoilAttestation(tinfoilBaseURL).then((att) => ({
            posture: tinfoilTeePosture(att),
            attestation: att,
          }))
        : (isPrivateerTee ? loadServerAttestation(modelId) : loadAttestation(apiKey!, baseURL, modelId)).then(
            (att) => ({ posture: teePosture(att), attestation: att }),
          );
    pending
      .then(({ posture, attestation }) => {
        if (!ignore) setState({ kind: "ready", posture, attestation });
      })
      .catch(() => {
        if (!ignore) setState({ kind: "error" });
      });
    return () => {
      ignore = true;
    };
  }, [isNearai, isPrivateerTee, isTinfoil, apiKey, baseURL, tinfoilBaseURL, modelId]);

  return state;
}
