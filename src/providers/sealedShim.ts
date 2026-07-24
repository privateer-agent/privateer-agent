// Sealed-mode (EHBP) transport for the account channel.
//
// Background: the `privateer` provider runs inference through the server at
// `${server}/api/agent/v1`, which reads the prompt in cleartext (it assembles/
// forwards the body). For `tinfoil/*` models that means the badge honestly reads
// "Trusted Execution (unconfirmed)": the enclave is real, but a quote fetched
// through the proxy can't be bound to THIS connection (see account.ts and
// docs/tee-privateer-tinfoil-ehbp.md).
//
// Sealed mode closes that. Tinfoil's EHBP (Encrypted HTTP Body Protocol) is HPKE
// applied to the HTTP body only, independent of TLS, and the enclave's attestation
// binds the HPKE key. The Privateer server already exposes a blind relay for it
// (`${server}/api/sealed/:provider`, treeview/server/routes/sealed.js): it forwards
// the ciphertext body + the `Ehbp-*` headers, injects the provider key, and meters
// on a cleartext usage header — it never sees the prompt. The treeview app already
// speaks this (client/services/pipeline/transport/tinfoilProvider.ts).
//
// Pi's `openai-completions` adapter does the HTTP itself and exposes no custom-fetch
// hook, so we can't seal from inside the provider config. Instead we run an
// in-process loopback HTTP server (this module): Pi POSTs a plain OpenAI request to
// it, the shim seals the body to the attested enclave via Tinfoil's `SecureClient`,
// forwards Pi's account bearer + the cleartext `X-Sealed-Model` billing header, and
// streams the decrypted response back. The provider points the `tinfoil/*` models'
// per-model `baseUrl` at this shim (account.ts).
//
// The one SecureClient per provider is shared by the data plane (the shim) and the
// posture check (attestSealed), so the green shield reflects the exact client that
// carries the tokens — the invariant: attest the key we actually seal to.

import http from "node:http";
import { Readable } from "node:stream";
import { SecureClient } from "tinfoil";
import { serverBaseUrl } from "../auth/privateer.ts";
import { attestPhala, phalaSealedFetch } from "./phalaSeal.ts";
import { iterateSSE } from "./phala/sse.ts";

// Providers whose enclave supports application-layer body encryption + client-verified
// attestation, and for which we have a Node client: Tinfoil (EHBP) and Phala (ACI
// E2EE). NEAR does NOT — it's attested TLS only, so it stays the confidential
// (unsealed) path, not sealed. See docs/tee-verified-tinfoil-ehbp.md §12.
export type SealedProvider = "tinfoil" | "phala";

// Sealed mode is OFF until verified end-to-end against a live relay (a real EHBP
// round-trip needs the deployed relay + TINFOIL_API_KEY; see the live checklist in
// docs/tee-privateer-tinfoil-ehbp.md). Off = the current plaintext path + honest
// yellow badge, untouched. Flip with PRIVATEER_SEALED=1.
export function sealedEnabled(): boolean {
  const v = process.env.PRIVATEER_SEALED;
  return v === "1" || v === "true";
}

// The sealed provider a model id routes through, or null if it isn't a sealed
// model (or its client isn't available here). Mirrors the server's prefix routing.
export function sealedProviderFor(modelId: string): SealedProvider | null {
  if (modelId.startsWith("tinfoil/")) return "tinfoil";
  if (modelId.startsWith("phala/")) return "phala";
  return null;
}

// The blind-relay base for a provider — SecureClient fetches `${base}/attestation`
// and we POST `${base}/v1/chat/completions`.
export function relayBase(provider: SealedProvider): string {
  return `${serverBaseUrl().replace(/\/+$/, "")}/api/sealed/${provider}`;
}

// ── One SecureClient per provider (shared: data plane + posture) ──────────────

const clients = new Map<SealedProvider, SecureClient>();
const readyPromises = new Map<SealedProvider, Promise<void>>();

function client(provider: SealedProvider): SecureClient {
  let c = clients.get(provider);
  if (!c) {
    const base = relayBase(provider);
    // attestationBundleURL == base: the SDK appends `/attestation`, which the relay
    // proxies to Tinfoil's ATC. transport 'ehbp' = HPKE body sealing.
    c = new SecureClient({ baseURL: base, attestationBundleURL: base, transport: "ehbp" });
    clients.set(provider, c);
  }
  return c;
}

// Attest once and cache; on failure drop the memo so a later call re-attests
// rather than caching the error (mirrors the treeview provider).
export function ready(provider: SealedProvider): Promise<void> {
  let p = readyPromises.get(provider);
  if (!p) {
    p = client(provider)
      .ready()
      .catch((err) => {
        readyPromises.delete(provider);
        throw err as Error;
      });
    readyPromises.set(provider, p);
  }
  return p;
}

export interface SealedAttestation {
  ok: boolean;
  enclave?: string;
  error?: string;
}

// Drive the provider's client-side attestation (the SAME client/keyset the shim
// seals with). A green result is a quote we verified ourselves, bound to the key we
// encrypt to — that earns tee-verified. Tinfoil: SecureClient.ready() (HPKE-key
// match). Phala: verifyReportBinding + TDX quote (see phalaSeal.ts).
export async function attestSealed(provider: SealedProvider): Promise<SealedAttestation> {
  if (provider === "phala") return attestPhala();
  try {
    await ready(provider);
    return { ok: true, enclave: client(provider).getEnclaveURL() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Pure request shaping (unit-tested without an enclave) ─────────────────────

export interface ForwardPlan {
  url: string;
  headers: Record<string, string>;
  body: string;
  sealedModel: string;
}

// Turn Pi's plain OpenAI request into what we seal to the relay:
//   - strip the `${provider}/` prefix from the body model (the enclave wants the
//     bare id; the body is encrypted so the relay can't strip it — we must),
//   - keep the full prefixed id on the cleartext X-Sealed-Model header (the relay
//     prices billing off it — it never reads the body),
//   - forward Pi's account bearer verbatim (the relay authenticates the JWT; on a
//     401 the relay's response propagates so Pi refreshes and retries).
export function buildForward(
  provider: SealedProvider,
  rawBody: string,
  authHeader: string | undefined,
): ForwardPlan {
  let body = rawBody;
  let sealedModel = "unknown";
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed.model === "string") {
      sealedModel = parsed.model;
      const prefix = `${provider}/`;
      if (parsed.model.startsWith(prefix)) parsed.model = parsed.model.slice(prefix.length);
      body = JSON.stringify(parsed);
    }
  } catch {
    // Not JSON — forward unchanged (X-Sealed-Model stays "unknown"; relay logs it).
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Sealed-Model": sealedModel,
  };
  if (authHeader) headers.Authorization = authHeader;
  return { url: `${relayBase(provider)}/v1/chat/completions`, headers, body, sealedModel };
}

// ── Loopback HTTP shim ────────────────────────────────────────────────────────

const PATH_RE = /^\/(tinfoil|phala)\/v1\/chat\/completions$/;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

let shimBase: string | null = null;
let shimStarting: Promise<string> | null = null;

// The shim's base URL once listening, else null. account.ts reads this to decide
// whether a sealed model can point its baseUrl at the shim yet.
export function sealedShimBase(): string | null {
  return shimBase;
}

// Start the loopback shim once and return its base URL. Idempotent.
export function ensureSealedShim(): Promise<string> {
  if (shimBase) return Promise.resolve(shimBase);
  if (!shimStarting) shimStarting = startShim();
  return shimStarting;
}

function startShim(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `sealed shim: ${(e as Error).message}` } }));
      });
    });
    server.on("error", reject);
    // Loopback only, ephemeral port. unref so the shim never keeps the process alive.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        shimBase = `http://127.0.0.1:${addr.port}`;
        resolve(shimBase);
      } else {
        reject(new Error("sealed shim: could not determine listen port"));
      }
    });
    server.unref();
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Defense in depth: only serve loopback peers (the port is ephemeral + bound to
  // 127.0.0.1 already, but reject anything else outright).
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) {
    res.writeHead(403).end();
    return;
  }
  const path = (req.url ?? "").split("?")[0];
  const m = PATH_RE.exec(path);
  if (req.method !== "POST" || !m) {
    res.writeHead(404).end();
    return;
  }
  const provider = m[1] as SealedProvider;
  const raw = await readBody(req);
  const authHeader = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : undefined;

  if (provider === "phala") {
    await handlePhala(raw.toString("utf8"), authHeader, res);
    return;
  }

  // Tinfoil (EHBP): SecureClient.fetch seals/opens transparently, so we just pass the
  // body through and pipe the decrypted response.
  const plan = buildForward(provider, raw.toString("utf8"), authHeader);
  await ready(provider);
  const upstream = await client(provider).fetch(plan.url, {
    method: "POST",
    headers: plan.headers,
    body: plan.body,
  });

  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
  });
  if (upstream.body) {
    const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    // If Pi hangs up mid-stream, stop pulling from the enclave.
    res.on("close", () => nodeStream.destroy());
    nodeStream.pipe(res);
    nodeStream.on("error", () => {
      if (!res.writableEnded) res.end();
    });
  } else {
    res.end(await upstream.text());
  }
}

// Phala (ACI E2EE): fields are encrypted individually, so unlike Tinfoil we must
// decrypt the response with the per-call channel — chunk by chunk for SSE, or the
// whole JSON when non-streaming — and re-emit cleartext OpenAI to Pi.
async function handlePhala(
  rawBody: string,
  authHeader: string | undefined,
  res: http.ServerResponse,
): Promise<void> {
  const ac = new AbortController();
  res.on("close", () => ac.abort());
  const { res: up, channel, streaming } = await phalaSealedFetch(rawBody, authHeader, ac.signal);

  if (!up.ok) {
    res.writeHead(up.status, { "Content-Type": up.headers.get("content-type") ?? "application/json" });
    res.end(await up.text());
    return;
  }

  if (streaming && up.body) {
    res.writeHead(up.status, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" });
    for await (const obj of iterateSSE(up.body as ReadableStream<Uint8Array>)) {
      const opened = await channel.openChunk(obj as Record<string, unknown>);
      res.write(`data: ${JSON.stringify(opened)}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  // Non-streaming: decrypt the single JSON body.
  const opened = await channel.open((await up.json()) as Record<string, unknown>);
  res.writeHead(up.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(opened));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
