import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { RelayClient, type RelayCallbacks } from "../src/remote/relayClient.ts";
import { mediaModality } from "../src/util/images.ts";

// Build a RelayClient with no-op callbacks plus the captures a test cares about.
function makeClient(over: Partial<RelayCallbacks> = {}) {
  const received: { name: string; mediaType: string; base64: string }[] = [];
  const status: string[] = [];
  const cb: RelayCallbacks = {
    onPrompt: () => {},
    onInterrupt: () => {},
    onApprovalResponse: () => {},
    onControllerAttached: () => {},
    onAttachment: (f) => received.push(f),
    onStatus: (s) => status.push(s),
    ...over,
  };
  const client = new RelayClient(cb);
  // handle() is private; drive raw frames through it the way onmessage would.
  const feed = (frame: unknown) => (client as any).handle(Buffer.from(JSON.stringify(frame)));
  return { client, received, status, feed };
}

test("reassembles a chunked attachment in order and decodes to the original bytes", () => {
  const { received, feed } = makeClient();
  const original = Buffer.from("const x = 42;\nexport default x;\n", "utf8");
  const b64 = original.toString("base64");
  // Split into 3 deliberately uneven chunks to exercise the join.
  const a = b64.slice(0, 5), b = b64.slice(5, 9), c = b64.slice(9);

  feed({ type: "attach_begin", id: "att-0", name: "x.ts", mediaType: "text/plain", size: original.length });
  feed({ type: "attach_chunk", id: "att-0", seq: 0, data: a });
  feed({ type: "attach_chunk", id: "att-0", seq: 1, data: b });
  feed({ type: "attach_chunk", id: "att-0", seq: 2, data: c });
  feed({ type: "attach_end", id: "att-0" });

  assert.equal(received.length, 1);
  assert.equal(received[0].name, "x.ts");
  assert.equal(received[0].mediaType, "text/plain");
  assert.equal(Buffer.from(received[0].base64, "base64").toString("utf8"), original.toString("utf8"));
});

test("interleaves two concurrent transfers without cross-contaminating", () => {
  const { received, feed } = makeClient();
  const one = Buffer.from("alpha").toString("base64");
  const two = Buffer.from("bravo").toString("base64");

  feed({ type: "attach_begin", id: "a", name: "a.txt", mediaType: "text/plain", size: 5 });
  feed({ type: "attach_begin", id: "b", name: "b.txt", mediaType: "text/plain", size: 5 });
  feed({ type: "attach_chunk", id: "a", seq: 0, data: one.slice(0, 4) });
  feed({ type: "attach_chunk", id: "b", seq: 0, data: two });
  feed({ type: "attach_chunk", id: "a", seq: 1, data: one.slice(4) });
  feed({ type: "attach_end", id: "b" });
  feed({ type: "attach_end", id: "a" });

  const byName = Object.fromEntries(received.map((r) => [r.name, Buffer.from(r.base64, "base64").toString("utf8")]));
  assert.equal(byName["a.txt"], "alpha");
  assert.equal(byName["b.txt"], "bravo");
});

test("drops a chunk whose begin was never seen (no crash, no emit)", () => {
  const { received, feed } = makeClient();
  feed({ type: "attach_chunk", id: "ghost", seq: 0, data: "AAAA" });
  feed({ type: "attach_end", id: "ghost" });
  assert.equal(received.length, 0);
});

test("rejects an oversize file at begin and never emits it", () => {
  const { received, status, feed } = makeClient();
  feed({ type: "attach_begin", id: "big", name: "huge.bin", mediaType: "application/pdf", size: 11 * 1024 * 1024 });
  feed({ type: "attach_chunk", id: "big", seq: 0, data: "AAAA" });
  feed({ type: "attach_end", id: "big" });
  assert.equal(received.length, 0);
  assert.ok(status.some((s) => /huge\.bin/.test(s)));
});

test("caps simultaneous in-flight transfers", () => {
  const { status, feed } = makeClient();
  // 8 is the limit; the 9th begin is dropped with a notice.
  for (let i = 0; i < 8; i++) feed({ type: "attach_begin", id: `t${i}`, name: `f${i}.txt`, mediaType: "text/plain", size: 1 });
  feed({ type: "attach_begin", id: "t8", name: "overflow.txt", mediaType: "text/plain", size: 1 });
  assert.ok(status.some((s) => /overflow\.txt/.test(s)));
});

test("mediaModality classifies binary vs text-like", () => {
  assert.equal(mediaModality("image/png"), "image");
  assert.equal(mediaModality("image/jpeg"), "image");
  assert.equal(mediaModality("application/pdf"), "document");
  assert.equal(mediaModality("audio/mpeg"), "audio");
  assert.equal(mediaModality("video/mp4"), "video");
  // text-like → null means "inline as text" on the relay path
  assert.equal(mediaModality("text/plain"), null);
  assert.equal(mediaModality("application/json"), null);
});
