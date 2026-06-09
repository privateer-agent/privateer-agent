import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { AttachmentStore } from "../src/util/attachmentStore.ts";
import type { Attachment } from "../src/util/images.ts";

function att(n: number, bytes: number[], path = "shot.png"): Attachment {
  return {
    n,
    data: Buffer.from(bytes).toString("base64"),
    mediaType: "image/png",
    modality: "image",
    path,
  };
}

test("register persists bytes to a scratch file retrievable by #n", () => {
  const store = new AttachmentStore();
  try {
    const bytes = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];
    const stored = store.register(att(1, bytes));
    assert.ok(stored, "returns a stored entry");
    assert.equal(store.get(1)?.path, stored!.path);
    assert.deepEqual([...readFileSync(stored!.path)], bytes, "bytes round-trip exactly");
    assert.equal(extname(stored!.path), ".png", "keeps the source extension");
  } finally {
    store.cleanup();
  }
});

test("register is idempotent per #n and reports available refs", () => {
  const store = new AttachmentStore();
  try {
    const first = store.register(att(2, [1]));
    const again = store.register(att(2, [9, 9, 9])); // same n, new bytes ignored
    assert.equal(first!.path, again!.path);
    assert.deepEqual([...readFileSync(first!.path)], [1], "first write wins");
    store.register(att(5, [2]));
    assert.deepEqual(store.refs(), [2, 5]);
    assert.equal(store.get(99), undefined);
  } finally {
    store.cleanup();
  }
});

test("cleanup removes the scratch dir and clears refs", () => {
  const store = new AttachmentStore();
  const stored = store.register(att(1, [1, 2, 3]))!;
  assert.ok(existsSync(stored.path));
  store.cleanup();
  assert.equal(existsSync(stored.path), false);
  assert.deepEqual(store.refs(), []);
});

// kept local to avoid importing path just for the assertion above
function extname(p: string): string {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i);
}
