// PRIVATEER_HOME must point somewhere disposable before the auth module resolves paths.
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-gzip-test";
process.env.PRIVATEER_SERVER_URL = "https://example.invalid";

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import {
  installGzipRequestBodies,
  uninstallGzipRequestBodiesForTests,
} from "../src/util/gzipRequestBody.ts";

const INFER = "https://example.invalid/api/agent/v1/chat/completions";

interface Seen {
  url: string;
  encoding: string | null;
  contentLength: string | null;
  body: unknown;
}

/** Install over a stub fetch and return the requests it saw. */
function withStub(responses: Response[] | (() => Response)): Seen[] {
  const seen: Seen[] = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  globalThis.fetch = (async (input: any, init: any) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: typeof input === "string" ? input : input.url,
      encoding: headers.get("content-encoding"),
      contentLength: headers.get("content-length"),
      body: init?.body,
    });
    return queue ? (queue.shift() ?? new Response("{}")) : (responses as () => Response)();
  }) as typeof fetch;
  installGzipRequestBodies();
  return seen;
}

afterEach(() => uninstallGzipRequestBodiesForTests());

test("gzips an inference POST and preserves the payload", async () => {
  const seen = withStub([new Response('{"ok":true}')]);
  const payload = JSON.stringify({ messages: [{ role: "user", content: "read ../../etc/hosts" }] });
  const res = await fetch(INFER, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(payload.length) },
    body: payload,
  });

  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].encoding, "gzip");
  // A stale content-length would truncate the compressed request on the wire.
  assert.equal(seen[0].contentLength, null);
  assert.ok(seen[0].body instanceof Uint8Array);
  assert.equal(gunzipSync(seen[0].body as Uint8Array).toString("utf8"), payload);
});

test("leaves other hosts, other paths and bodyless requests alone", async () => {
  const seen = withStub(() => new Response("{}"));
  await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "hi" });
  await fetch("https://example.invalid/api/models", { method: "POST", body: "hi" });
  await fetch(INFER); // no init at all
  await fetch(INFER, { method: "GET" });

  assert.equal(seen.length, 4);
  assert.deepEqual(
    seen.map((s) => s.encoding),
    [null, null, null, null],
  );
  assert.deepEqual(
    seen.map((s) => s.body),
    ["hi", "hi", undefined, undefined],
  );
});

test("never double-encodes a body the caller already compressed", async () => {
  const seen = withStub(() => new Response("{}"));
  await fetch(INFER, {
    method: "POST",
    headers: { "content-encoding": "gzip" },
    body: "already-compressed",
  });
  assert.equal(seen[0].body, "already-compressed");
});

test("a stream body passes through uncompressed (it could not be resent)", async () => {
  const seen = withStub(() => new Response("{}"));
  const body = new ReadableStream();
  await fetch(INFER, { method: "POST", body, duplex: "half" } as RequestInit);
  assert.equal(seen[0].encoding, null);
  assert.equal(seen[0].body, body);
});

test("retries in plaintext and disables itself when a hop refuses the encoding", async () => {
  const seen = withStub([
    new Response("unsupported media type", { status: 415 }),
    new Response('{"ok":true}'),
    new Response('{"ok":true}'),
  ]);

  const first = await fetch(INFER, { method: "POST", body: "payload" });
  assert.equal(first.status, 200);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].encoding, "gzip");
  assert.equal(seen[1].encoding, null);
  assert.equal(seen[1].body, "payload"); // resent verbatim

  // Valve latched: the next call goes out in plaintext with no probe.
  await fetch(INFER, { method: "POST", body: "payload" });
  assert.equal(seen.length, 3);
  assert.equal(seen[2].encoding, null);
});

test("keeps the compressed response when plaintext does no better", async () => {
  const seen = withStub([
    new Response("bad request", { status: 400 }),
    new Response("<html>blocked</html>", { status: 403 }),
    new Response('{"ok":true}'),
  ]);

  const res = await fetch(INFER, { method: "POST", body: "payload" });
  assert.equal(res.status, 400, "the original response is the honest one to report");

  // A 403 from the plaintext probe is the WAF itself, so compression stays ON.
  await fetch(INFER, { method: "POST", body: "payload" });
  assert.equal(seen.length, 3);
  assert.equal(seen[2].encoding, "gzip");
});

test("a 403 is never retried in plaintext — that is the block we are dodging", async () => {
  const seen = withStub([new Response("<html>blocked</html>", { status: 403 })]);
  const res = await fetch(INFER, { method: "POST", body: "payload" });
  assert.equal(res.status, 403);
  assert.equal(seen.length, 1);
});

test("install is idempotent and the kill switch keeps fetch untouched", async () => {
  const seen = withStub(() => new Response("{}"));
  installGzipRequestBodies();
  installGzipRequestBodies();
  await fetch(INFER, { method: "POST", body: "payload" });
  assert.equal(seen.length, 1, "one wrapper, not three");
  uninstallGzipRequestBodiesForTests();

  process.env.PRIVATEER_NO_GZIP = "1";
  try {
    const seen2 = withStub(() => new Response("{}"));
    await fetch(INFER, { method: "POST", body: "payload" });
    assert.equal(seen2[0].encoding, null);
    assert.equal(seen2[0].body, "payload");
  } finally {
    delete process.env.PRIVATEER_NO_GZIP;
  }
});
