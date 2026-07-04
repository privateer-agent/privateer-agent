import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { RelayClient, type RelayCallbacks } from "../src/remote/relayClient.ts";
import { mediaTypeForPath } from "../src/util/images.ts";

// Build a RelayClient with no-op callbacks and a fake OPEN socket that records
// every outbound frame, so sendFile's framing can be asserted without a server.
function makeClient() {
  const cb: RelayCallbacks = {
    onPrompt: () => {},
    onInterrupt: () => {},
    onApprovalResponse: () => {},
    onControllerAttached: () => {},
    onAttachment: () => {},
  };
  const client = new RelayClient(cb);
  const frames: any[] = [];
  const ws = {
    readyState: 1, // WebSocket.OPEN
    send: (s: string) => frames.push(JSON.parse(s)),
  };
  (client as any).ws = ws;
  return { client, frames, ws };
}

test("sendFile streams begin → ordered chunks → end and the chunks reassemble", async () => {
  const { client, frames } = makeClient();
  // ~400k base64 chars → 3 chunks at the 180k cap.
  const base64 = Buffer.alloc(300_000, 7).toString("base64");
  const res = await client.sendFile({ name: "report.pdf", mediaType: "application/pdf", base64, size: 300_000 });

  assert.deepEqual(res, { ok: true });
  assert.equal(frames[0].type, "file_begin");
  assert.equal(frames[0].name, "report.pdf");
  assert.equal(frames[0].mediaType, "application/pdf");
  assert.equal(frames[0].size, 300_000);
  assert.equal(frames[frames.length - 1].type, "file_end");
  assert.equal(frames[frames.length - 1].id, frames[0].id);

  const chunks = frames.slice(1, -1);
  assert.equal(chunks.length, 3);
  chunks.forEach((c, i) => {
    assert.equal(c.type, "file_chunk");
    assert.equal(c.id, frames[0].id);
    assert.equal(c.seq, i);
    assert.ok(c.data.length <= 180_000);
  });
  assert.equal(chunks.map((c) => c.data).join(""), base64);
});

test("sendFile fits a small file in a single chunk", async () => {
  const { client, frames } = makeClient();
  const base64 = Buffer.from("hello").toString("base64");
  const res = await client.sendFile({ name: "hi.txt", mediaType: "text/plain", base64, size: 5 });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(frames.map((f) => f.type), ["file_begin", "file_chunk", "file_end"]);
  assert.equal(frames[1].data, base64);
});

test("sendFile fails cleanly when the socket is not open", async () => {
  const { client, frames, ws } = makeClient();
  ws.readyState = 3; // CLOSED
  const res = await client.sendFile({ name: "x.txt", mediaType: "text/plain", base64: "AAAA", size: 3 });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /not connected/);
  assert.equal(frames.length, 0);
});

test("sendFile rejects a file over the 10 MB relay cap without sending frames", async () => {
  const { client, frames } = makeClient();
  const res = await client.sendFile({ name: "huge.bin", mediaType: "application/octet-stream", base64: "AAAA", size: 11 * 1024 * 1024 });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /10 MB/);
  assert.equal(frames.length, 0);
});

test("sendFile aborts mid-transfer when the socket drops, without a trailing file_end", async () => {
  const { client, frames, ws } = makeClient();
  const base64 = Buffer.alloc(300_000, 7).toString("base64"); // 3 chunks
  const origSend = ws.send;
  ws.send = (s: string) => {
    origSend(s);
    // Kill the socket right after the first chunk goes out.
    if (JSON.parse(s).type === "file_chunk") ws.readyState = 3;
  };
  const res = await client.sendFile({ name: "big.pdf", mediaType: "application/pdf", base64, size: 300_000 });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /mid-transfer/);
  assert.ok(!frames.some((f) => f.type === "file_end"));
});

test("mediaTypeForPath classifies binary, text, and unknown extensions", () => {
  assert.equal(mediaTypeForPath("shot.png"), "image/png");
  assert.equal(mediaTypeForPath("doc.PDF"), "application/pdf");
  assert.equal(mediaTypeForPath("notes.md"), "text/plain");
  assert.equal(mediaTypeForPath("data.json"), "application/json");
  assert.equal(mediaTypeForPath("index.html"), "text/html");
  assert.equal(mediaTypeForPath("chart.svg"), "image/svg+xml");
  assert.equal(mediaTypeForPath("table.csv"), "text/csv");
  assert.equal(mediaTypeForPath("app.bin"), "application/octet-stream");
  assert.equal(mediaTypeForPath("no-extension"), "application/octet-stream");
});
