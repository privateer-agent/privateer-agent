import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync } from "node:fs";
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
