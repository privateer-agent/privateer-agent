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

// ── Oversized / non-API error bodies ─────────────────────────────────────────
//
// An inference endpoint does not always answer as an API. Put a WAF, a proxy or a
// captive portal in front of one and a rejected request comes back as an HTML page,
// which the provider SDK folds whole into `error.message` — status first, body after.
//
// The incident this exists for: the account channel's edge WAF answered a turn with a
// 403 block page carrying three inline base64 web fonts, so `errorMessage` was 221 KB.
// Pi printed it into the terminal in full, appended it to the session file on every
// attempt (a 1.8 MB session), and ran its transient-error regex over it — and a
// megabyte of base64 reliably contains "429", "500", "502", so a permanent 403 looked
// retryable and burned the whole retry budget before the user saw anything.
//
// Both halves are fixed where Pi reads the message (see the patch in
// patches/@earendil-works+pi-coding-agent+*.patch, which mirrors these two helpers):
// squeeze the page down to the line a person can act on, and let the STATUS decide
// retryability rather than a substring of the body.
//
// A first-attempt hard 4xx is also terminal for the post-run loop. Stock Pi still
// falls through to compaction when _retryAttempt is 0, and a session that already
// has usage will summarise — another LLM call to the same blocked endpoint. The
// summarizer retries on the raw HTML (it contains "500"/"502"), so the agent looks
// hung until that budget burns. The patch returns false from _handlePostAgentRun
// before _checkCompaction when isHardHttpFailure matches.

/** Hard cap on an error message we display, persist, or classify. */
export const MAX_ERROR_CHARS = 2_000;

/** How much of an HTML page's visible text is worth keeping. */
const MAX_PAGE_TEXT_CHARS = 600;

const HTML_DOC = /<!doctype html|<html[\s>]/i;

/** Tags whose contents are never prose: markup, styling, or a logo. */
const NON_PROSE = /<(script|style|svg|head|noscript)\b[\s\S]*?<\/\1\s*>/gi;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'",
};

function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
      const key = code.toLowerCase();
      if (ENTITIES[key] !== undefined) return ENTITIES[key];
      if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16) || 0) || m;
      if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10) || 0) || m;
      return m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reduce a provider error message to something worth showing, storing and classifying.
 *
 * An HTML page collapses to its status, its <title> and its visible text — which is
 * where a WAF puts the one detail the user needs to report ("Request ID: …"). Anything
 * else over the cap is truncated. Text already short and non-HTML is returned unchanged,
 * so ordinary provider errors pass through untouched.
 */
export function compactProviderError(raw: string): string {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  if (!HTML_DOC.test(text)) {
    if (text.length <= MAX_ERROR_CHARS) return text;
    return `${text.slice(0, MAX_ERROR_CHARS)}… [dropped ${text.length - MAX_ERROR_CHARS} chars]`;
  }

  const status = /^\s*(\d{3})\b/.exec(text)?.[1];
  const title = plainText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? "");
  const body = plainText(text.replace(NON_PROSE, " "));
  const visible = [title, body].filter(Boolean).join(" — ").slice(0, MAX_PAGE_TEXT_CHARS);

  return (
    `${status ?? "HTTP error"} — an HTML page, not an API response (something in front of ` +
    `the provider answered: a WAF, a proxy, or a captive portal): ` +
    `${visible || "(no readable text)"} [dropped ${text.length} chars of HTML]`
  );
}

// Client-error statuses that CAN clear on their own: a timeout, a lock conflict, an
// early-data replay, a throttle. Every other 4xx is the request itself being wrong.
const TRANSIENT_CLIENT_STATUS = new Set([408, 409, 425, 429]);

/**
 * True when the message opens with an HTTP status that retrying cannot clear.
 *
 * Both provider paths put the status first — the OpenAI-shaped SDK builds
 * `"403 <body>"`, pi-messages builds `"403 Forbidden: <body>"` — so the status is a
 * fact we can read, where a substring of the body is only a guess. 5xx and messages
 * with no leading status are left to the caller's own classifier.
 */
export function isHardHttpFailure(text: string | null | undefined): boolean {
  const m = /^\s*(\d{3})\b/.exec(typeof text === "string" ? text : "");
  if (!m) return false;
  const status = Number(m[1]);
  return status >= 400 && status < 500 && !TRANSIENT_CLIENT_STATUS.has(status);
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

  // Unrecognized: show the provider's own words rather than swallow them — but an
  // unrecognized error is exactly where a WAF block page or a megabyte of markup
  // arrives, so it goes through the compactor first.
  return out({ message: compactProviderError(text) });
}

// ── Throttles: waiting the right amount, and only once ───────────────────────
//
// The incident this exists for: the account channel's edge answered a burst of
// turns with a bare `429` — no body, no JSON, just the status. Two retry layers
// exist and the wrong one was live. pi-ai's `retryProviderRequest` is the good
// one (it reads `retry-after`, jitters, caps at 60s) but it takes `maxRetries ??
// 0` and Pi's settings gave it no default, so it ran ZERO retries. All the
// patience came from the session-level loop: 3 attempts at 2s/4s/8s, no
// `retry-after`, no jitter — ~14 seconds against a window that is conventionally
// 60. Exhaustion was arithmetic, not bad luck. Then the pre-prompt compaction
// fired the summarizer into the same throttled endpoint and died there too, so
// the user's next message was answered with "Auto-compaction cancelled".
//
// The fix is three-part and mirrored into the Pi patch: give the provider layer a
// real retry budget, make the session layer's backoff honour a server-stated
// delay and jitter, and don't summarise into an endpoint that just throttled us.

/** A throttle can clear on its own — but only after the server's stated window. */
export function isThrottleFailure(text: string | null | undefined): boolean {
  return /^\s*429\b/.test(typeof text === "string" ? text : "");
}

/** Longest we will sit on a single backoff. Past this the user deserves the turn back. */
export const MAX_RETRY_DELAY_MS = 60_000;

// A bare 429 carries nothing, but a provider that bothers to explain itself puts the
// number in the text one of a few ways. Read it where it is offered; guess otherwise.
const RETRY_AFTER_PATTERNS = [
  /retry-after(?:-ms)?["'\s:=]+(\d+(?:\.\d+)?)/i,
  /(?:retry|try) again in (\d+(?:\.\d+)?)\s*(m?s|seconds?|minutes?)/i,
  /retry after (\d+(?:\.\d+)?)\s*(m?s|seconds?|minutes?)/i,
];

/**
 * The server's requested delay in ms, or null when it did not state one.
 *
 * `retry-after` is seconds by convention and `retry-after-ms` is milliseconds; a
 * prose "try again in 30 seconds" carries its own unit. Values are clamped rather
 * than rejected — a provider asking for an hour gets our ceiling, not a crash.
 */
export function retryAfterMs(text: string | null | undefined): number | null {
  const s = typeof text === "string" ? text : "";
  for (const re of RETRY_AFTER_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    const value = Number.parseFloat(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const unit = (m[2] ?? "").toLowerCase();
    const ms =
      unit === "ms" || /retry-after-ms/i.test(m[0])
        ? value
        : unit.startsWith("m") && unit !== "ms"
          ? value * 60_000
          : value * 1000;
    return Math.min(Math.max(Math.round(ms), 1_000), MAX_RETRY_DELAY_MS);
  }
  return null;
}

/**
 * How long the session-level retry should wait before attempt `attempt` (1-based).
 *
 * A server-stated delay wins outright — it is the only number here that is a fact.
 * Otherwise back off exponentially from `baseDelayMs`, capped, and then jitter DOWN
 * by up to 25%. The jitter is the point of the exercise: without it every parallel
 * request that tripped the same limit wakes at the identical millisecond and trips
 * it again, which is how one throttled turn becomes a throttled session.
 *
 * `rand` is injectable so the schedule can be asserted in a test.
 */
export function retryDelayMs(
  errorText: string | null | undefined,
  attempt: number,
  baseDelayMs: number,
  rand: () => number = Math.random,
): number {
  const stated = retryAfterMs(errorText);
  if (stated != null) return stated;
  const n = Math.max(1, Math.floor(attempt));
  const backoff = Math.min(baseDelayMs * 2 ** (n - 1), MAX_RETRY_DELAY_MS);
  return Math.round(backoff * (1 - rand() * 0.25));
}

/**
 * Describe an error we only have the TEXT of, for the one place that has nothing else.
 *
 * `describeError` above reads structured fields off the error object; by the time a
 * message reaches the TUI's `showError` those are gone and all that survives is a
 * string the SDK built status-first ("429 status code (no body)"). That string is
 * what the user was shown six times during the incident. Recover the status from it
 * and say the same thing `describeError` would. Returns null when there is no leading
 * status to read, so ordinary messages print unchanged.
 */
export function describeErrorText(text: string | null | undefined): DescribedError | null {
  const s = typeof text === "string" ? text : "";
  const status = Number(/^\s*(\d{3})\b/.exec(s)?.[1] ?? NaN);
  if (!Number.isFinite(status)) return null;

  if (status === 429) {
    const stated = retryAfterMs(s);
    return {
      message: redactText(`Rate limited (429).`),
      hint: stated
        ? `The provider asked for ${Math.ceil(stated / 1000)}s. Wait that long and send it again.`
        : "Wait a moment and send it again — or run /model to switch to another provider.",
      retryable: true,
    };
  }
  if (status === 401 || status === 403) {
    return {
      message: redactText(compactProviderError(s)),
      hint: "Check your credentials — run /login to re-authenticate.",
    };
  }
  if (status === 404) {
    return {
      message: redactText(compactProviderError(s)),
      hint: "Check the model id — run /model to switch.",
    };
  }
  if (status >= 500) {
    return {
      message: redactText(compactProviderError(s)),
      hint: "Usually transient — retry shortly.",
      retryable: true,
    };
  }
  return null;
}
