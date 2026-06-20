import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError } from "../src/engine/errors.ts";

// Reconstruct the AI SDK's APICallError shape closely enough to exercise the
// field extraction. Only the fields describeError reads need to be present.
function apiError(opts: {
  statusCode: number;
  message: string;
  providerMessage?: string;
  model?: string;
  url?: string;
}): Error {
  const err = new Error(opts.message) as Error & Record<string, unknown>;
  err.statusCode = opts.statusCode;
  err.url = opts.url ?? "https://openrouter.ai/api/v1/chat/completions";
  if (opts.model) err.requestBodyValues = { model: opts.model };
  if (opts.providerMessage) {
    err.data = { error: { message: opts.providerMessage } };
    err.responseBody = JSON.stringify({ error: { message: opts.providerMessage } });
  }
  return err;
}

test("classifies OpenRouter data-policy 404 with an actionable hint", () => {
  const d = describeError(
    apiError({
      statusCode: 404,
      message: "No endpoints available matching your guardrail restrictions and data policy.",
      providerMessage: "No endpoints available matching your guardrail restrictions and data policy.",
      model: "anthropic/claude-opus-4.8-fast",
    }),
  );
  assert.match(d.message, /data-policy settings/);
  assert.match(d.message, /claude-opus-4\.8-fast/);
  assert.match(d.hint ?? "", /openrouter\.ai\/settings\/privacy/);
});

test("classifies auth and rate-limit statuses", () => {
  const auth = describeError(apiError({ statusCode: 401, message: "Unauthorized" }));
  assert.match(auth.message, /Authentication failed for OpenRouter \(401\)/);

  const rate = describeError(apiError({ statusCode: 429, message: "Too Many Requests" }));
  assert.equal(rate.retryable, true);
  assert.match(rate.message, /Rate limited/);
});

test("surfaces a Privateer account cap (flat body + code) and does not retry", () => {
  // The Privateer backend returns a flat `{ message, code }` body, not the nested
  // `{ error: { message } }` shape — and a daily cap must not be retried.
  const err = new Error("Too Many Requests") as Error & Record<string, unknown>;
  err.statusCode = 429;
  err.url = "http://localhost:5000/api/agent/v1/chat/completions";
  err.responseBody = JSON.stringify({
    message: "Daily message limit of 25 reached. Upgrade or top up to continue.",
    code: "DAILY_CAP_HIT",
    effectiveTier: "free",
    cap: 25,
    kind: "message",
  });
  const d = describeError(err);
  assert.match(d.message, /Daily message limit of 25 reached/);
  assert.doesNotMatch(d.message, /\(429\)/); // not the generic "Rate limited (429)"
  assert.notEqual(d.retryable, true);
  assert.match(d.hint ?? "", /top up|\/provider/);
});

test("unwraps an AI_RetryError to reach the cap on its lastError", () => {
  // What the SDK actually throws once retries are exhausted: a wrapper whose own
  // message is the bare "Too Many Requests" and whose useful fields live on
  // `lastError`. describeError must peel it to surface the cap message.
  const apiErr = new Error("Too Many Requests") as Error & Record<string, unknown>;
  apiErr.statusCode = 429;
  apiErr.url = "http://localhost:5000/api/agent/v1/chat/completions";
  apiErr.responseBody = JSON.stringify({
    message: "Daily message limit of 25 reached. Upgrade or top up to continue.",
    code: "DAILY_CAP_HIT",
  });
  const retryErr = new Error("Failed after 3 attempts. Last error: Too Many Requests") as Error &
    Record<string, unknown>;
  retryErr.lastError = apiErr;

  const d = describeError(retryErr);
  assert.match(d.message, /Daily message limit of 25 reached/);
  assert.notEqual(d.retryable, true);
});

test("falls back to the provider message for unrecognized errors", () => {
  const d = describeError(
    apiError({ statusCode: 400, message: "wrapper", providerMessage: "invalid 'temperature'" }),
  );
  assert.equal(d.message, "invalid 'temperature'");
  assert.equal(d.hint, undefined);
});

test("redacts secrets that leak into provider error text", () => {
  const d = describeError(
    apiError({
      statusCode: 400,
      message: "bad request",
      providerMessage: "key sk-or-v1-0123456789abcdef0123456789abcdef was rejected",
    }),
  );
  assert.doesNotMatch(d.message, /sk-or-v1-0123456789/);
  assert.match(d.message, /«redacted»/);
});

test("handles plain errors and strings without throwing", () => {
  assert.equal(describeError(new Error("boom")).message, "boom");
  assert.equal(describeError("just a string").message, "just a string");
});
