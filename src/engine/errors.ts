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
  model?: string;
  provider?: string;
}

const HOST_LABELS: Record<string, string> = {
  "openrouter.ai": "OpenRouter",
  "api.anthropic.com": "Anthropic",
  "api.openai.com": "OpenAI",
  "cloud-api.near.ai": "NEAR AI",
};

// Pull structured fields off an unknown error without trusting any one shape.
function extract(err: unknown): ErrorFacts {
  const e = (err ?? {}) as Record<string, unknown>;
  const statusCode = typeof e.statusCode === "number" ? e.statusCode : undefined;

  // The provider's own message, preferred over the SDK's wrapper text.
  let providerMessage: string | undefined;
  const data = e.data as { error?: { message?: unknown } } | undefined;
  if (typeof data?.error?.message === "string") {
    providerMessage = data.error.message;
  } else if (typeof e.responseBody === "string") {
    try {
      const parsed = JSON.parse(e.responseBody) as { error?: { message?: unknown } };
      if (typeof parsed?.error?.message === "string") providerMessage = parsed.error.message;
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

  return { statusCode, providerMessage, model, provider };
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
  const text = facts.providerMessage ?? rawMessage(err);
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
