import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { AttachmentStore } from "../src/util/attachmentStore.ts";
import { makeSaveAttachmentTool } from "../src/tools/saveAttachment.ts";
import { RemoteBridge } from "../src/remote/remoteBridge.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");

test("AttachmentStore assigns ascending refs and persists bytes", () => {
  const store = new AttachmentStore();
  const a = store.register({ name: "photo.png", mediaType: "image/png", base64: b64("PNGDATA") });
  const bb = store.register({ name: "doc.pdf", mediaType: "application/pdf", base64: b64("PDFDATA") });
  assert.equal(a.n, 1);
  assert.equal(bb.n, 2);
  assert.deepEqual(store.refs(), [1, 2]);
  assert.equal(readFileSync(a.path, "utf8"), "PNGDATA");
  assert.equal(store.get(2)?.name, "doc.pdf");
  assert.equal(store.get(9), undefined);
  store.cleanup();
});

test("save_attachment writes a stored attachment to disk", async () => {
  const store = new AttachmentStore();
  store.register({ name: "note.txt", mediaType: "text/plain", base64: b64("hello attach") });
  const tool = makeSaveAttachmentTool(store);
  const out = "/private/tmp/claude-501/pv-att-test/saved.txt";
  rmSync("/private/tmp/claude-501/pv-att-test", { recursive: true, force: true });
  const res: any = await tool.execute("t1", { ref: 1, path: out }, undefined, undefined, { cwd: "/tmp" });
  assert.match(res.content[0].text, /Saved attachment #1/);
  assert.ok(existsSync(out));
  assert.equal(readFileSync(out, "utf8"), "hello attach");
  store.cleanup();
  rmSync("/private/tmp/claude-501/pv-att-test", { recursive: true, force: true });
});

test("save_attachment on a missing ref reports what's available", async () => {
  const store = new AttachmentStore();
  store.register({ name: "a", mediaType: "text/plain", base64: b64("x") });
  const res: any = await makeSaveAttachmentTool(store).execute("t", { ref: 5, path: "/tmp/x" }, undefined, undefined, {});
  assert.match(res.content[0].text, /No attachment #5.*#1/s);
  store.cleanup();
});

test("bridge onAttachment fires the owner's hook (→ store)", () => {
  const store = new AttachmentStore();
  const bridge = new RemoteBridge({
    onPrompt: () => {},
    onAttachment: (file) => store.register(file),
  });
  bridge.callbacks.onAttachment({ name: "app.png", mediaType: "image/png", base64: b64("Z") });
  assert.deepEqual(store.refs(), [1]);
  assert.equal(store.get(1)?.name, "app.png");
  store.cleanup();
});

// A session that owns its own relay (the harbor's live task spawns) registers the pair
// itself, since the gate extension stands down inside the daemon. If this factory ever
// stopped registering one of them, that session would silently lose file transfer in
// that direction — the tool simply wouldn't exist for the model.
test("relay file tools factory registers both directions against the given bridge", async () => {
  const { makeRelayFileTools } = await import("../src/tools/relayFileTools.ts");
  const store = new AttachmentStore();
  let sent: unknown = null;
  const bridge = {
    isConnected: () => true,
    sendFile: async (file: unknown) => { sent = file; return { ok: true }; },
  };
  const registered = new Map<string, any>();
  makeRelayFileTools(bridge, store)({ registerTool: (t: any) => registered.set(t.name, t) });

  assert.deepEqual([...registered.keys()].sort(), ["save_attachment", "send_file_to_client"]);

  // …and the send tool talks to THAT bridge, not some other session's.
  const path = "/private/tmp/claude-501/pv-relayfile-test.txt";
  writeFileSync(path, "payload");
  const res: any = await registered.get("send_file_to_client").execute("t", { path }, undefined, undefined, {});
  assert.match(res.content[0].text, /Sent pv-relayfile-test\.txt/);
  assert.equal((sent as any)?.name, "pv-relayfile-test.txt");
  rmSync(path, { force: true });
  store.cleanup();
});
