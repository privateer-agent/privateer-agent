import { test } from "node:test";
import assert from "node:assert/strict";
import { compactProviderError, describeError, isAccountCapCode, isHardHttpFailure } from "../src/engine/errors.ts";

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

// ── Error bodies that aren't API responses ───────────────────────────────────
//
// The incident: the account channel's edge WAF answered a turn with a 403 block page
// whose inline base64 web fonts made a 221 KB `errorMessage`. It was printed whole,
// written to the session file on every attempt, and — because that much base64 always
// contains "429"/"500"/"502" — matched Pi's transient-error regex, so a permanent 403
// was retried three times. The patched agent-session runs both helpers below; these
// tests are where their behaviour is pinned.

/** The shape of the page that caused this, minus 220 KB of font. */
const BLOCK_PAGE =
  `403 <!DOCTYPE html>\n<html lang="en">\n  <head>\n    <title>Blocked</title>\n` +
  `    <style>@font-face { src: url("data:font/woff2;base64,${"QUJDNTAwNTAyNDI5".repeat(400)}"); }</style>\n` +
  `  </head>\n  <body>\n    <script>var t = 1;</script>\n` +
  `    <h1>403 - Forbidden</h1>\n` +
  `    <p>Your request was blocked by this site&#x27;s web application firewall (WAF).</p>\n` +
  `    <p>Request ID: a2c64e100ae6d331</p>\n` +
  `    <svg viewBox="0 0 64 12"><path d="M11.4 1.0C9.6 0.9 8.1 2.2 7.8 3.9Z" /></svg>\n` +
  `  </body>\n</html>\n`;

test("an HTML block page collapses to its status and readable text", () => {
  const out = compactProviderError(BLOCK_PAGE);
  assert.ok(out.length < 800, `expected a short message, got ${out.length} chars`);
  assert.match(out, /^403 /);
  assert.match(out, /Blocked/);
  assert.match(out, /web application firewall/);
  assert.match(out, /Request ID: a2c64e100ae6d331/); // the one detail worth reporting
  assert.match(out, /dropped \d+ chars of HTML/);
  assert.doesNotMatch(out, /base64|woff2|<path|var t = 1/); // fonts, markup, script
  assert.equal(out.includes("&#x27;"), false, "entities are decoded, not shown raw");
});

test("an ordinary provider error passes through untouched", () => {
  const plain = `429 {"error":{"message":"Rate limit reached","code":"rate_limit"}}`;
  assert.equal(compactProviderError(plain), plain);
});

test("a huge non-HTML body is truncated, not dropped", () => {
  const out = compactProviderError(`500 ${"x".repeat(50_000)}`);
  assert.ok(out.length < 2_200, `expected a capped message, got ${out.length} chars`);
  assert.match(out, /^500 x+… \[dropped \d+ chars\]$/);
});

test("hard 4xx statuses are never retryable, whatever the body says", () => {
  // The exact shape that retried three times: a 403 whose body contains "500".
  assert.equal(isHardHttpFailure(BLOCK_PAGE), true);
  assert.equal(isHardHttpFailure("403 Forbidden: blocked"), true); // pi-messages shape
  assert.equal(isHardHttpFailure("400 bad request"), true);
  assert.equal(isHardHttpFailure("404 no such model"), true);
  // After compactProviderError the status is still first, so the post-run loop can
  // skip compaction instead of summarising against the same blocked endpoint.
  assert.equal(isHardHttpFailure(compactProviderError(BLOCK_PAGE)), true);
});

test("statuses that can clear on their own are left to Pi's classifier", () => {
  for (const s of [408, 409, 425, 429, 500, 502, 503, 529]) {
    assert.equal(isHardHttpFailure(`${s} something`), false, `${s} must stay retryable`);
  }
  assert.equal(isHardHttpFailure("fetch failed"), false); // no status → not our call
  assert.equal(isHardHttpFailure(undefined), false);
});
