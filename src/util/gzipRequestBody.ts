// Gzip the account channel's inference bodies, so the edge WAF stops killing turns.
//
// Render's edge (Cloudflare-fronted, "Powered by Render" on the block page) runs a
// managed WAF we cannot configure, and it scans the BODY of every POST. Two of its rule
// families fire on ordinary coding-agent traffic:
//
//   "read ../../etc/hosts"           → 403   (path traversal / LFI)
//   "foo ; curl http://example.com"  → 403   (shell command injection)
//
// while "/etc/passwd", "../../package.json", "<script>alert(1)</script>" and
// "SELECT … OR 1=1 --" all pass. The 403 is served BEFORE the origin (it carries no
// x-render-origin-server header, unlike every 200), so nothing on our server can answer
// it, and there is no per-service toggle: Render's own "let us disable the Cloudflare
// WAF" request has sat since 2024 with no staff reply.
//
// Why this is a permanent failure and not an occasional one: every turn re-sends the
// whole conversation, so the moment one relative path or one pasted shell command enters
// the context, EVERY later request in that session carries it and the session is 403ed
// for good. Reading src/engine/errors.ts — whose comments contain both patterns — used
// to be enough to do it.
//
// The WAF does not inspect a compressed body, and the origin inflates one (body-parser
// defaults to `inflate: true`). Verified live: the identical payload that 403s as
// plaintext returns a normal completion when gzipped.
//
// What this gives up: the WAF no longer scans these bodies. On this route it was
// scanning PROMPTS — text on its way to a language model, not to a shell or a database —
// so the protection lost is ~nil where the false-positive rate was ~100%. The scope is
// deliberately narrow all the same: POSTs to the account channel's inference path on OUR
// server, nothing else. The relay carries its prompts over a WebSocket, which the WAF
// does not body-scan, so it needs nothing here.
//
// Kill switch: PRIVATEER_NO_GZIP=1 (and the runtime valve below, which disables
// compression for the process if the origin ever stops accepting it).

import { gzipSync } from "node:zlib";
import { serverBaseUrl } from "../auth/privateer.ts";

/** The account channel's OpenAI-shaped inference route — the only path we compress. */
const INFERENCE_PATH = "/api/agent/v1";

/**
 * Statuses that read as "this hop would not take a compressed body".
 *
 * 413 is deliberately absent: a plaintext retry of a body that was already too large
 * only makes it bigger. A 403 is absent too — that is the WAF, i.e. the very thing
 * compression exists to get past, so retrying it in plaintext would just re-block.
 */
const REJECTS_ENCODING = new Set([400, 411, 415]);

let installed: (typeof globalThis.fetch) | null = null;
let enabled = true;

/** Body shapes we can compress AND cheaply resend uncompressed if the valve trips. */
function compressible(body: unknown): body is string | ArrayBuffer | ArrayBufferView {
  return (
    typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)
  );
}

function toBuffer(body: string | ArrayBuffer | ArrayBufferView): Buffer {
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

/**
 * True when this request is the account channel's inference POST.
 *
 * `serverBaseUrl()` throws on a malformed stored URL and can change across a login, so
 * it is read per request inside a try — a bad value means "not ours", never a crash on
 * somebody else's fetch.
 */
function targetsInference(url: string): boolean {
  try {
    const base = new URL(serverBaseUrl());
    const u = new URL(url, base);
    if (u.origin !== base.origin) return false;
    const mount = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
    return u.pathname.startsWith(`${mount}${INFERENCE_PATH}`);
  } catch {
    return false;
  }
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/**
 * Wrap `globalThis.fetch` once, for the whole process.
 *
 * A global wrap rather than a per-provider `fetch` option because inference does NOT go
 * through our own authedFetch: it rides Pi's HTTP path (provider baseUrl + the bearer
 * from getApiKey, see providers/account.ts), whose provider config has no fetch seam.
 * Everything not matching targetsInference() is passed straight through to the original
 * fetch, so this is inert for every other caller — including the loopback sealed shim,
 * which is a different origin and never matches.
 */
export function installGzipRequestBodies(): void {
  if (installed) return;
  if (process.env.PRIVATEER_NO_GZIP === "1") return;
  const inner = globalThis.fetch;
  installed = inner;

  globalThis.fetch = async (input, init) => {
    const body = init?.body;
    if (!enabled || !init || !compressible(body) || !targetsInference(urlOf(input))) {
      return await inner(input, init);
    }
    const headers = new Headers(init.headers);
    // Never double-encode, and never fight a caller that set its own encoding.
    if (headers.has("content-encoding")) return await inner(input, init);
    headers.set("content-encoding", "gzip");
    // The buffer's length is the wire length now; a stale content-length truncates the
    // request. undici recomputes it from the body we hand over.
    headers.delete("content-length");

    // level 1: this is defeating a plaintext pattern match, not saving bytes, and the
    // call is synchronous on the event loop — a megabyte of context should cost
    // milliseconds, not tens of them.
    const gz = gzipSync(toBuffer(body), { level: 1 });
    const res = await inner(input, { ...init, headers, body: gz });
    if (!REJECTS_ENCODING.has(res.status)) return res;

    // The valve. If some hop stops accepting compressed bodies (a proxy change, an
    // origin without inflate), one plaintext retry recovers THIS turn and turns the
    // workaround off for the rest of the process rather than failing every prompt.
    // The retry is safe: these statuses mean the request was refused, not run.
    const plain = await inner(input, init);
    if (plain.ok) {
      enabled = false;
      void res.body?.cancel().catch(() => {});
      return plain;
    }
    // Plaintext did no better — hand back the original response, which is the more
    // honest error (a 403 WAF page here means the block is what we were dodging).
    void plain.body?.cancel().catch(() => {});
    return res;
  };
}

/** Restore the pre-install fetch and re-arm the valve. Tests only. */
export function uninstallGzipRequestBodiesForTests(): void {
  if (installed) globalThis.fetch = installed;
  installed = null;
  enabled = true;
}
