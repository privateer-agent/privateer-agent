import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractImages } from "../src/util/images.ts";

test("extractImages reads referenced images, ignoring non-images and missing files", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-img-"));
  try {
    writeFileSync(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    writeFileSync(join(dir, "notes.txt"), "not an image");
    const imgs = extractImages("look at @shot.png and notes.txt and gone.jpg", dir);
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0].mediaType, "image/png");
    assert.equal(imgs[0].path, "shot.png");
    assert.ok(imgs[0].data.length > 0, "base64 data present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extractImages dedupes and infers media types", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-img2-"));
  try {
    writeFileSync(join(dir, "a.jpeg"), Buffer.from([1, 2, 3]));
    const imgs = extractImages("@a.jpeg again a.jpeg", dir);
    assert.equal(imgs.length, 1); // same file referenced twice → once
    assert.equal(imgs[0].mediaType, "image/jpeg");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
