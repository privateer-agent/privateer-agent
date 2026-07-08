import { test } from "node:test";
import assert from "node:assert/strict";
import { webSearchTool } from "../src/tools/web.ts";
import { autoApproveGate } from "../src/permissions/gate.ts";

// A minimal stand-in for DuckDuckGo's HTTP 202 anti-bot "anomaly" page. The marker
// strings are the ones isDdgBlocked() keys off of.
const ANOMALY_PAGE =
  '<!DOCTYPE html><html><body><div class="anomaly-modal">' +
  "Unfortunately, bots use DuckDuckGo too. If this error persists, please let us know." +
  "</div></body></html>";

const RESULTS_PAGE =
  '<html><body>' +
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">First result</a>' +
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo">Second result</a>' +
  "</body></html>";

const ctx = { gate: autoApproveGate } as any;

function withFetch<T>(status: number, body: string, fn: () => Promise<T>): Promise<T> {
  const real = global.fetch;
  global.fetch = (async () => ({
    status,
    headers: { get: () => "text/html" },
    text: async () => body,
  })) as any;
  return fn().finally(() => {
    global.fetch = real;
  });
}

test("web_search: DDG rate-limit page returns a terminal message that discourages retrying", async () => {
  const out = await withFetch(202, ANOMALY_PAGE, () => webSearchTool(ctx).execute({ query: "anything" }));
  assert.match(out, /rate-limited/i);
  assert.match(out, /retry/i);
  // Must NOT tell the model "markup may have changed / try again" — that invited the loop.
  assert.doesNotMatch(out, /markup may have changed/i);
});

test("web_search: a normal results page is parsed into title + decoded URL lines", async () => {
  const out = await withFetch(200, RESULTS_PAGE, () => webSearchTool(ctx).execute({ query: "example" }));
  assert.match(out, /First result/);
  assert.match(out, /https:\/\/example\.com\/one/);
  assert.match(out, /Second result/);
});
