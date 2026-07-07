import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError, isAccountCapCode } from "../src/engine/errors.ts";

// errors.ts is provider-agnostic status/network mapping (the AI-SDK error nesting
// in `extract` is read defensively, so it survives Pi's shapes). Verifies the
// user-facing messages + the account-cap detection that auth/relay rely on.

test("isAccountCapCode matches the backend cap codes", () => {
  assert.equal(isAccountCapCode("DAILY_CAP_HIT"), true);
  assert.equal(isAccountCapCode("MONTHLY_QUOTA"), true);
  assert.equal(isAccountCapCode("INSUFFICIENT_BALANCE"), true);
  assert.equal(isAccountCapCode("rate_limited"), false);
  assert.equal(isAccountCapCode(undefined), false);
});

test("401 → authentication failed, not retryable", () => {
  const d = describeError({ statusCode: 401, url: "https://api.openai.com/v1/chat" });
  assert.match(d.message, /Authentication failed/i);
  assert.match(d.message, /OpenAI/);
  assert.ok(!d.retryable);
});

test("account cap (429 + cap code) → surfaces backend message, not retryable", () => {
  const d = describeError({
    statusCode: 429,
    responseBody: JSON.stringify({ code: "DAILY_CAP_HIT", message: "Daily message limit of 25 reached." }),
  });
  assert.match(d.message, /Daily message limit of 25 reached/);
  assert.ok(!d.retryable); // must NOT retry a hard cap
  assert.match(d.hint ?? "", /Privateer account/);
});

test("plain 429 → rate limited, retryable", () => {
  const d = describeError({ statusCode: 429, url: "https://openrouter.ai/api/v1" });
  assert.match(d.message, /Rate limited/i);
  assert.equal(d.retryable, true);
});

test("5xx → provider error, retryable", () => {
  const d = describeError({ statusCode: 503 });
  assert.equal(d.retryable, true);
});

test("network errno → network error", () => {
  const d = describeError({ code: "ECONNREFUSED", url: "https://openrouter.ai/api/v1" });
  assert.match(d.message, /Network error|Cannot connect/i);
});

test("localhost refused → 'nothing is listening', not retryable", () => {
  const d = describeError({ code: "ECONNREFUSED", url: "http://localhost:11434/v1/chat" });
  assert.match(d.message, /nothing is listening/i);
  assert.ok(!d.retryable);
});

test("data-policy / no-endpoints text → actionable OpenRouter message", () => {
  const d = describeError({ statusCode: 404, responseBody: JSON.stringify({ error: { message: "No endpoints found matching your data policy" } }) });
  assert.match(d.message, /data-policy settings/i);
});
