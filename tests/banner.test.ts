import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The startup banner (extensions/privateer-brand.ts) frames itself: it measures every
// row, takes the widest as the inner width, then pads each row out to it before the
// closing "│". That arithmetic is only correct if the measurement matches what the
// TERMINAL draws — and ⚓ (U+2693) carries emoji presentation, so it occupies TWO cells
// while a naive .length calls it one. The result was a right border shoved a column past
// the frame on the PRIVATEER.md row: a visible break in an otherwise straight edge.
// These tests render the real banner and assert the frame is square.

const home = mkdtempSync(join(tmpdir(), "privateer-banner-"));
process.env.PRIVATEER_HOME = home;

const { headerComponent } = await import("../extensions/privateer-brand.ts");

// Visible width, computed independently of the module under test: strip SGR escapes,
// then count ⚓ as the two cells a terminal gives it.
function cells(s: string): number {
  let w = 0;
  for (const ch of s.replace(/\x1b\[[0-9;]*m/g, "")) w += ch === "⚓" ? 2 : 1;
  return w;
}

function render(width: number): string[] {
  return headerComponent({ background: "dark" }, "privateer").render(width);
}

test("every banner row is the same visible width", () => {
  const lines = render(120);
  const widths = new Set(lines.map(cells));
  assert.equal(widths.size, 1, `ragged frame: widths ${[...widths].join(", ")}`);
});

test("the anchored PRIVATEER.md row does not push the border out", () => {
  // A context file in cwd makes contextLine render the ⚓ variant — the row that broke.
  const cwd = process.cwd();
  try {
    process.chdir(home);
    writeFileSync(join(home, "PRIVATEER.md"), "# test\n");
    const lines = render(120);
    const anchored = lines.filter((l) => l.includes("⚓"));
    assert.ok(anchored.length > 0, "expected an anchored context row");
    const widths = new Set(lines.map(cells));
    assert.equal(widths.size, 1, `ragged frame: widths ${[...widths].join(", ")}`);
  } finally {
    process.chdir(cwd);
  }
});

test("rows too long for the terminal are clipped, not wrapped", () => {
  // A narrow terminal caps the inner width; anything longer must be trimmed so the
  // closing border still lands inside the window.
  for (const width of [30, 44, 60]) {
    const lines = render(width);
    const widths = new Set(lines.map(cells));
    assert.equal(widths.size, 1, `ragged frame at width ${width}: ${[...widths].join(", ")}`);
    assert.ok([...widths][0] <= width, `banner overflows a ${width}-column terminal`);
  }
});
