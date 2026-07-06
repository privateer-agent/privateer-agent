// Turn provider / AI-SDK errors into something a human can act on. These errors
// (e.g. `AI_APICallError`) carry structured fields well beyond `.message` —
// statusCode, responseBody, the request's model — but Node's default printer
// would dump the whole object (request messages and all) to the terminal,
// unredacted. We read the useful fields defensively and emit a short message
// plus an actionable hint, both run through secret redaction.

import { redactText } from "../util/redact.ts";

export interface DescribedError {
  message: string; // short, user-facing, redacted
  hint?: string; // actionable next step, rendered dim below the message
  retryable?: boolean;
}

interface ErrorFacts {
  statusCode?: number;
  providerMessage?: string;
  code?: string; // provider's machine-readable error code, e.g. "DAILY_CAP_HIT"
  errno?: string; // Node socket-level code, e.g. "ECONNREFUSED"
  model?: string;
  provider?: string;
  url?: string; // the endpoint the failing request targeted
  message?: string; // deepest non-empty Error message in the chain
}

const HOST_LABELS: Record<string, string> = {
  "openrouter.ai": "OpenRouter",
  "api.anthropic.com": "Anthropic",
  "api.openai.com": "OpenAI",
  "cloud-api.near.ai": "NEAR AI",
  "localhost:11434": "Ollama",
  "127.0.0.1:11434": "Ollama",
};

// Socket-level failures Node/undici report via an error `code`. Distinct from the
// provider's machine code (which comes out of the response body) — these mean the
// request never got a response at all.
const NETWORK_ERRNO =
  /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/;

// Pull structured fields off an unknown error without trusting any one shape.
//
// The AI SDK nests the useful error: retry exhaustion throws AI_RetryError, whose
// `.lastError` is the APICallError carrying statusCode / url / responseBody, whose
// `.cause` on a connection failure is the socket error (often an AggregateError
// with an EMPTY message but an errno code). No single level has everything, so
// walk the whole chain and merge: HTTP-ish facts keep the first (shallowest)
// value found, while `message` keeps the deepest NON-EMPTY one — inner messages
// are more specific ("Cannot connect to API") than the wrapper's ("Failed after
// 3 attempts…"), but the socket error at the very bottom may have none at all.
function extract(err: unknown): ErrorFacts {
  const facts: ErrorFacts = {};

  // The provider's own message + machine code, preferred over the SDK's wrapper
  // text. Providers disagree on shape: OpenAI/OpenRouter nest under `error`, while
  // the Privateer account backend returns a flat `{ message, code }` (e.g. a daily
  // usage cap). Read both shapes; keep the first message/code we find.
  const readBody = (body: unknown) => {
    const b = body as
      | { error?: { message?: unknown; code?: unknown }; message?: unknown; code?: unknown }
      | undefined;
    if (!b || typeof b !== "object") return;
    const msg = b.error?.message ?? b.message;
    if (facts.providerMessage == null && typeof msg === "string") facts.providerMessage = msg;
    const c = b.error?.code ?? b.code;
    if (facts.code == null && typeof c === "string") facts.code = c;
  };

  let cur: unknown = err;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const e = cur as Record<string, unknown>;

    if (facts.statusCode == null && typeof e.statusCode === "number") facts.statusCode = e.statusCode;
    readBody(e.data);
    if (typeof e.responseBody === "string") {
      try {
        readBody(JSON.parse(e.responseBody));
      } catch {
        /* responseBody wasn't JSON — fall back to the wrapper message */
      }
    }

    const reqBody = e.requestBodyValues as { model?: unknown } | undefined;
    if (facts.model == null && typeof reqBody?.model === "string") facts.model = reqBody.model;

    if (facts.url == null && typeof e.url === "string" && /^https?:/.test(e.url)) {
      facts.url = e.url;
      try {
        facts.provider = HOST_LABELS[new URL(e.url).host];
      } catch {
        /* not a URL */
      }
    }

    if (facts.errno == null && typeof e.code === "string" && NETWORK_ERRNO.test(e.code)) {
      facts.errno = e.code;
    }
    if (typeof e.message === "string" && e.message.trim()) facts.message = e.message;

    const next = e.lastError ?? e.cause;
    if (!next || next === cur) break;
    cur = next;
  }

  return facts;
}

// Machine codes the Privateer backend returns for a hard account cap (daily /
// monthly message or token limit, or an empty balance). Exported so the provider
// fetch wrapper can recognise the same condition and rewrite the 429 to a
// non-retryable status — otherwise the AI SDK burns its full retry budget on a
// limit that won't clear by retrying. Keep this the single source of truth.
const CAP_CODE = /CAP|QUOTA|LIMIT_REACHED|INSUFFICIENT|TOP_?UP/i;

export function isAccountCapCode(code: string | null | undefined): boolean {
  return typeof code === "string" && CAP_CODE.test(code);
}

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Map a provider error to a friendly message + hint. Falls back to the raw
// (redacted) message for anything we don't recognize, so nothing is swallowed.
export function describeError(err: unknown): DescribedError {
  const facts = extract(err);
  const status = facts.statusCode;
  const text = facts.providerMessage ?? facts.message ?? rawMessage(err);
  const forModel = facts.model ? ` for ${facts.model}` : "";
  const forProvider = facts.provider ? ` for ${facts.provider}` : "";

  const out = (d: DescribedError): DescribedError => ({
    message: redactText(d.message),
    hint: d.hint ? redactText(d.hint) : undefined,
    retryable: d.retryable,
  });

  // OpenRouter: the account's data-policy / guardrail settings exclude every
  // provider that could serve this model. The phrasing is distinctive, so match on
  // it regardless of status — OpenRouter returns this as a 404 *or* a 403, and the
  // 403 must not fall through to the generic "authentication failed" branch below.
  // This is a "you must act" error: never retried (no `retryable` flag).
  if (/data[- ]?policy|guardrail|no endpoints?\b/i.test(text)) {
    return out({
      message: `No provider endpoint matches your data-policy settings${forModel}.`,
      hint: "Enable providers at https://openrouter.ai/settings/privacy, or pick a different model with /model.",
    });
  }
  // Privateer account usage cap (daily/monthly message or token limit). The
  // backend returns this as a 429 with a machine `code` like DAILY_CAP_HIT and a
  // ready-to-show message ("Daily message limit of 25 reached. Upgrade or top up
  // to continue."). Unlike a transient rate limit, retrying never helps — the user
  // must upgrade, top up, or switch providers — so surface the backend's own
  // message verbatim and do NOT mark it retryable (which would invite a retry).
  const capText = /limit of .* reached|upgrade or top ?up|usage limit reached/i.test(text);
  if (isAccountCapCode(facts.code) || (status === 429 && capText)) {
    return out({
      message: facts.providerMessage ?? text,
      hint: "Upgrade or top up your Privateer account, or run /provider to use your own API key.",
    });
  }
  // Privateer machine-login expiry (thrown by the session spawn after the
  // server rejects the parent refresh token). The stored credentials are
  // already wiped; the only fix is a fresh /login, so say exactly that and
  // never mark it retryable.
  if (/privateer session expired/i.test(text)) {
    return out({
      message: "Your Privateer session expired — this terminal was signed out.",
      hint: "Run /login to sign back in to your Privateer account.",
    });
  }
  if (status === 401 || status === 403) {
    return out({
      message: `Authentication failed${forProvider} (${status}).`,
      hint: "Check the API key — run /provider, or set the provider's API key env var.",
    });
  }
  if (status === 402) {
    return out({
      message: `Request rejected for billing reasons${forProvider} (402).`,
      hint: "Check your account credits or billing.",
    });
  }
  if (status === 404) {
    return out({
      message: `Model not found${forModel} (404).`,
      hint: "Check the model id — run /model to switch.",
    });
  }
  if (status === 429) {
    return out({
      message: `Rate limited${forProvider} (429).`,
      hint: "Wait a moment and try again.",
      retryable: true,
    });
  }
  if (status != null && status >= 500) {
    return out({
      message: `Provider error${forProvider} (${status}).`,
      hint: "Usually transient — retry shortly.",
      retryable: true,
    });
  }
  if (
    facts.errno != null ||
    /fetch failed|cannot connect|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(text)
  ) {
    let origin: string | undefined;
    let localhost = false;
    if (facts.url) {
      try {
        const u = new URL(facts.url);
        origin = u.origin;
        localhost = /^(localhost$|127\.|0\.0\.0\.0$|\[::1\]$)/.test(u.hostname);
      } catch {
        /* not a URL */
      }
    }
    // A local inference server that refuses connections isn't a flaky network —
    // it isn't running. Say which one and how to start it; retrying won't help
    // until the user acts, so no `retryable` flag.
    if (localhost) {
      const label = facts.provider ?? "the local server";
      return out({
        message: `Cannot connect to ${label} at ${origin} — nothing is listening there.`,
        hint:
          facts.provider === "Ollama"
            ? "Start Ollama (run `ollama serve`, or open the Ollama app), then try again — or run /model to switch models."
            : "Start the server (or check its base URL), then try again — or run /model to switch models.",
      });
    }
    return out({
      message: `Network error reaching ${facts.provider ?? origin ?? "the provider"}.`,
      hint: "Check your connection and try again.",
      retryable: true,
    });
  }

  return out({ message: text });
}
