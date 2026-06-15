import { randomBytes } from "node:crypto";
import type { ProviderConfig } from "../config/schema.ts";
import { NEARAI_BASE_URL } from "./registry.ts";

// ── NEAR AI TEE attestation ──────────────────────────────────────────────────
// Every NEAR AI Cloud model runs inside a Trusted Execution Environment (Intel TDX
// confidential VM + NVIDIA confidential-computing GPU). On request, the gateway
// returns a cryptographic attestation report proving the model is running on
// genuine TEE hardware, with a signing key that never leaves the enclave bound to
// a caller-supplied nonce (report_data = signing_address || nonce). That lets us
// surface a live "this inference is confidential and verifiable" signal.
//
// We do a *pragmatic* check suited to a TUI: fetch a fresh report bound to our
// nonce and confirm it carries a TEE signing key plus hardware evidence. We do NOT
// re-validate the raw NVIDIA/Intel quote chains here — that's the job of the full
// verifier (github.com/nearai/cloud-verifier). The /verify command prints the raw
// report so a user can take it to that verifier.

const TIMEOUT_MS = 12_000;

export type TeePosture = "green" | "yellow" | "red";

export interface Attestation {
  model: string;
  nonce: string; // the 32-byte hex nonce we sent (freshness / anti-replay)
  signingAddress?: string; // TEE-bound key that signs inference responses
  nonceEchoed: boolean; // our nonce appears in the report → it's fresh, not replayed
  hardware: string[]; // detected evidence, e.g. ["NVIDIA", "Intel TDX"]
  raw: unknown; // full report, for /verify display + external verification
}

function baseFor(cfg: ProviderConfig): string {
  return (cfg.baseURL ?? NEARAI_BASE_URL).replace(/\/+$/, "");
}

// A 32-byte (64 hex char) random nonce, per NEAR's attestation API guidance.
export function randomNonce(): string {
  return randomBytes(32).toString("hex");
}

// Recursively find the first string value under any of `keys` (case-insensitive).
function deepFindString(obj: unknown, keys: string[]): string | undefined {
  const want = new Set(keys.map((k) => k.toLowerCase()));
  const stack: unknown[] = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      stack.push(...cur);
    } else if (cur && typeof cur === "object") {
      for (const [k, v] of Object.entries(cur)) {
        if (typeof v === "string" && want.has(k.toLowerCase()) && v.trim()) return v.trim();
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }
  return undefined;
}

// Fetch and interpret the attestation report for a model. Throws a readable error
// (mirroring listModels) on missing key / network / HTTP failure so the UI can
// show a dim "unverified" affordance rather than a colored verdict.
export async function fetchAttestation(cfg: ProviderConfig, modelId: string): Promise<Attestation> {
  if (!cfg.apiKey) throw new Error("no API key");
  const nonce = randomNonce();
  const url =
    `${baseFor(cfg)}/attestation/report` +
    `?model=${encodeURIComponent(modelId)}&signing_algo=ecdsa&nonce=${nonce}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let raw: unknown;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const hint = body.slice(0, 200).trim();
      throw new Error(`HTTP ${res.status} ${res.statusText}${hint ? ` — ${hint}` : ""}`);
    }
    raw = await res.json();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const signingAddress = deepFindString(raw, ["signing_address", "signingAddress", "address"]);
  // Hardware evidence is detected by scanning the serialized report for the quote
  // markers each vendor uses — robust to the exact response shape.
  const blob = JSON.stringify(raw).toLowerCase();
  const hardware: string[] = [];
  if (/nvidia|gpu/.test(blob)) hardware.push("NVIDIA");
  if (/intel|tdx/.test(blob)) hardware.push("Intel TDX");
  const nonceEchoed = blob.includes(nonce.toLowerCase());

  return { model: modelId, nonce, signingAddress, nonceEchoed, hardware, raw };
}

// Map an attestation to a status color. GREEN: fresh report bound to our nonce with
// a TEE signing key and hardware evidence (confidential + verifiable). YELLOW: a
// report came back but it's missing the signing key, hardware evidence, or nonce
// echo (attested but not fully confirmable here). RED: no attestation material.
export function teePosture(att: Attestation): TeePosture {
  if (!att.signingAddress && att.hardware.length === 0) return "red";
  if (att.signingAddress && att.hardware.length > 0 && att.nonceEchoed) return "green";
  return "yellow";
}
