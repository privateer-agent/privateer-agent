import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractAttachments,
  resolveAttachments,
  chipFor,
  describeAttachment,
} from "../src/util/images.ts";

// A full 8-byte PNG signature. (Just [0x89,'P','N','G'] is the macOS file-promise stub
// that capture-time validation now rejects — see the stub test below.)
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A PNG whose IHDR encodes the given dimensions (sig + length + "IHDR" + w + h + tail).
function pngWithDims(w: number, h: number): Buffer {
  const head = Buffer.concat([PNG, Buffer.from([0x00, 0x00, 0x00, 0x0d]), Buffer.from("IHDR")]);
  const wh = Buffer.alloc(8);
  wh.writeUInt32BE(w, 0);
  wh.writeUInt32BE(h, 4);
  return Buffer.concat([head, wh, Buffer.alloc(5)]); // 5-byte IHDR tail (bit depth, etc.)
}

test("extractAttachments reads binary files, ignoring non-files and text files", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-att-"));
  try {
    writeFileSync(join(dir, "shot.png"), PNG);
    writeFileSync(join(dir, "doc.pdf"), Buffer.from("%PDF-"));
    writeFileSync(join(dir, "notes.txt"), "not attached as binary");
    const atts = extractAttachments("@shot.png and doc.pdf and notes.txt and gone.jpg", dir);
    assert.equal(atts.length, 2);
    assert.deepEqual(
      atts.map((a) => a.modality).sort(),
      ["document", "image"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAttachments chips each modality with the right label and numbers", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-att2-"));
  try {
    writeFileSync(join(dir, "a.png"), PNG);
    writeFileSync(join(dir, "b.pdf"), Buffer.from("%PDF-"));
    writeFileSync(join(dir, "c.mp3"), Buffer.from([1, 2]));
    writeFileSync(join(dir, "d.mp4"), Buffer.from([3, 4]));
    const r = resolveAttachments("a.png b.pdf c.mp3 d.mp4", dir, 0);
    assert.equal(r.text, "[Image #1] [PDF #2] [Audio #3] [Video #4]");
    assert.deepEqual(
      r.attachments.map((a) => [a.modality, a.n]),
      [
        ["image", 1],
        ["document", 2],
        ["audio", 3],
        ["video", 4],
      ],
    );
    assert.equal(chipFor(r.attachments[1]), "[PDF #2]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAttachments inlines a text file and leaves a [file: name] marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-att3-"));
  try {
    writeFileSync(join(dir, "data.csv"), "a,b\n1,2\n");
    const r = resolveAttachments("look at data.csv please", dir, 0);
    assert.equal(r.text, "look at [file: data.csv] please");
    assert.equal(r.attachments.length, 0, "text file is not a binary attachment");
    assert.match(r.inlinedText, /--- data\.csv ---/);
    assert.match(r.inlinedText, /a,b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAttachments leaves an over-cap text file as a raw path", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-att4-"));
  try {
    writeFileSync(join(dir, "big.txt"), "x".repeat(100));
    const r = resolveAttachments("big.txt", dir, 0, 10); // cap 10 bytes < 100
    assert.equal(r.text, "big.txt", "left untouched for the read tool");
    assert.equal(r.inlinedText, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a promise-stub PNG (truncated signature) is rejected, not captured", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-att-stub-"));
  try {
    // The 4-byte stub macOS leaves for a screenshot-thumbnail drag.
    writeFileSync(join(dir, "drop.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(dir, "real.png"), PNG);
    assert.equal(extractAttachments("drop.png", dir).length, 0, "stub is not an attachment");
    // The raw path stays in the prompt (a visible signal the capture failed)…
    assert.equal(resolveAttachments("drop.png", dir, 0).text, "drop.png");
    // …while a real PNG still chips.
    assert.equal(resolveAttachments("real.png", dir, 0).text, "[Image #1]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAttachments captures size + dimensions for a drop-time provenance line", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-att-prov-"));
  try {
    const png = pngWithDims(1412, 496);
    writeFileSync(join(dir, "screenshot.png"), png);
    const r = resolveAttachments("screenshot.png", dir, 0);
    assert.equal(r.attachments.length, 1);
    const att = r.attachments[0];
    assert.deepEqual(att.dims, { w: 1412, h: 496 });
    assert.equal(att.bytes, png.length);
    // The line that makes a wrong-but-complete capture obvious before submit.
    assert.equal(describeAttachment(att), `screenshot.png · 1412×496 · ${png.length} B`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("describeAttachment omits dimensions for a non-image attachment", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-att-prov2-"));
  try {
    writeFileSync(join(dir, "spec.pdf"), Buffer.from("%PDF-1.4 body"));
    const r = resolveAttachments("spec.pdf", dir, 0);
    const att = r.attachments[0];
    assert.equal(att.dims, null);
    assert.match(describeAttachment(att), /^spec\.pdf · \d+ B$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAttachments handles spaced/quoted absolute paths and dedupes", () => {
  const dir = mkdtempSync(join(tmpdir(), "priv-att5-"));
  try {
    const abs = join(dir, "My Shot.png");
    writeFileSync(abs, PNG);
    // Backslash-escaped (terminal drag) and referenced twice → one attachment, same chip.
    const r = resolveAttachments(`${abs.replace(/ /g, "\\ ")} vs "${abs}"`, dir, 0);
    assert.equal(r.text, "[Image #1] vs [Image #1]");
    assert.equal(r.attachments.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
