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
  model?: string;
  provider?: string;
}

const HOST_LABELS: Record<string, string> = {
  "openrouter.ai": "OpenRouter",
  "api.anthropic.com": "Anthropic",
  "api.openai.com": "OpenAI",
  "cloud-api.near.ai": "NEAR AI",
};

// The AI SDK wraps the real provider error: a retry sequence that exhausts its
// attempts throws AI_RetryError, whose `.lastError` is the APICallError that
// actually carries statusCode / responseBody / requestBodyValues. Without peeling
// that off we'd read undefined for every field and fall back to the wrapper's bare
// "Too Many Requests". Follow `.lastError` (and a `.cause` that looks like a
// richer error) until we reach the one with the useful fields.
function unwrap(err: unknown): unknown {
  let cur = err;
  for (let i = 0; i < 5; i++) {
    if (!cur || typeof cur !== "object") break;
    const e = cur as Record<string, unknown>;
    const richer = e.statusCode == null && e.responseBody == null;
    const inner = e.lastError ?? (richer ? e.cause : undefined);
    if (!inner || inner === cur) break;
    cur = inner;
  }
  return cur;
}

// Pull structured fields off an unknown error without trusting any one shape.
function extract(err: unknown): ErrorFacts {
  const e = (err ?? {}) as Record<string, unknown>;
  const statusCode = typeof e.statusCode === "number" ? e.statusCode : undefined;

  // The provider's own message + machine code, preferred over the SDK's wrapper
  // text. Providers disagree on shape: OpenAI/OpenRouter nest under `error`, while
  // the Privateer account backend returns a flat `{ message, code }` (e.g. a daily
  // usage cap). Read both shapes; keep the first message/code we find.
  let providerMessage: string | undefined;
  let code: string | undefined;
  const readBody = (body: unknown) => {
    const b = body as
      | { error?: { message?: unknown; code?: unknown }; message?: unknown; code?: unknown }
      | undefined;
    if (!b || typeof b !== "object") return;
    const msg = b.error?.message ?? b.message;
    if (providerMessage == null && typeof msg === "string") providerMessage = msg;
    const c = b.error?.code ?? b.code;
    if (code == null && typeof c === "string") code = c;
  };
  readBody(e.data);
  if (typeof e.responseBody === "string") {
    try {
      readBody(JSON.parse(e.responseBody));
    } catch {
      /* responseBody wasn't JSON — fall back to the wrapper message */
    }
  }

  const reqBody = e.requestBodyValues as { model?: unknown } | undefined;
  const model = typeof reqBody?.model === "string" ? reqBody.model : undefined;

  let provider: string | undefined;
  if (typeof e.url === "string") {
    try {
      provider = HOST_LABELS[new URL(e.url).host];
    } catch {
      /* not a URL */
    }
  }

  return { statusCode, providerMessage, code, model, provider };
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
  const inner = unwrap(err);
  const facts = extract(inner);
  const status = facts.statusCode;
  const text = facts.providerMessage ?? rawMessage(inner);
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
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(text)) {
    return out({
      message: "Network error reaching the provider.",
      hint: "Check your connection and try again.",
      retryable: true,
    });
  }

  return out({ message: text });
}
