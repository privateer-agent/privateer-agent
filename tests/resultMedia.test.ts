import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResultMedia,
  classifyMedia,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "../src/routines/resultMedia.ts";
import { deliveryBrief, withBrief } from "../src/routines/resultBrief.ts";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "priv-media-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function file(dir: string, name: string, bytes: number): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(bytes, 7));
  return path;
}

test("stage: types a file by extension and resolves a relative path against cwd", () => {
  withDir((dir) => {
    file(dir, "shot.png", 2048);
    const media = new ResultMedia();
    const res = media.stage("shot.png", dir);
    assert.ok(res.ok);
    assert.equal(res.item.name, "shot.png");
    assert.equal(res.item.mediaType, "image/png");
    assert.equal(res.item.cls, "image");
    assert.equal(res.item.size, 2048);
    assert.equal(media.totalBytes(), 2048);
  });
});

test("stage: classification splits image / video / audio / everything else", () => {
  assert.equal(classifyMedia("image/webp"), "image");
  assert.equal(classifyMedia("video/mp4"), "video");
  assert.equal(classifyMedia("audio/mpeg"), "audio");
  assert.equal(classifyMedia("application/pdf"), "file");
  // An unknown extension falls back to octet-stream, which must still be attachable.
  assert.equal(classifyMedia("application/octet-stream"), "file");
});

test("stage: refuses a missing file, a directory and an empty file", () => {
  withDir((dir) => {
    mkdirSync(join(dir, "sub"));
    file(dir, "empty.png", 0);
    const media = new ResultMedia();
    assert.equal(media.stage("nope.png", dir).ok, false);
    assert.equal(media.stage("sub", dir).ok, false);
    assert.equal(media.stage("empty.png", dir).ok, false);
    assert.equal(media.list().length, 0);
  });
});

test("stage: caps count, per-file size and the per-result total", () => {
  withDir((dir) => {
    const media = new ResultMedia();
    for (let i = 0; i < MAX_ATTACHMENTS; i++) {
      file(dir, `s${i}.png`, 512);
      assert.ok(media.stage(`s${i}.png`, dir).ok, `attachment ${i} should be accepted`);
    }
    file(dir, "one-too-many.png", 512);
    const over = media.stage("one-too-many.png", dir);
    assert.equal(over.ok, false);
    assert.match((over as { reason: string }).reason, /limit/i);
    // The cap refuses the NEW file; nothing already staged is evicted for it.
    assert.equal(media.list().length, MAX_ATTACHMENTS);
  });
});

test("stage: a file over the per-attachment ceiling is refused with advice", () => {
  withDir((dir) => {
    file(dir, "big.mp4", MAX_ATTACHMENT_BYTES + 1);
    const res = new ResultMedia().stage("big.mp4", dir);
    assert.equal(res.ok, false);
    // The model can act on this: re-encode, trim, or send a frame.
    assert.match((res as { reason: string }).reason, /re-encode|trim|frame/i);
  });
});

test("stage: the total budget bounds one result even under the count cap", () => {
  withDir((dir) => {
    const media = new ResultMedia();
    // Three clips each just inside the per-file ceiling — legal on their own, and
    // together within a kilobyte of the per-result budget.
    const chunk = MAX_ATTACHMENT_BYTES - 1024;
    for (let i = 0; i < 3; i++) {
      file(dir, `c${i}.mp4`, chunk);
      assert.ok(media.stage(`c${i}.mp4`, dir).ok, `clip ${i} should be accepted`);
    }
    assert.ok(media.totalBytes() < MAX_TOTAL_ATTACHMENT_BYTES);
    // A fourth file well under the per-file cap still can't go: the budget is spent.
    file(dir, "one-more.png", 1024 * 1024);
    const fourth = media.stage("one-more.png", dir);
    assert.equal(fourth.ok, false);
    assert.match((fourth as { reason: string }).reason, /budget/i);
    assert.equal(media.list().length, 3);
  });
});

test("stage: re-attaching the same path replaces the earlier entry", () => {
  withDir((dir) => {
    const media = new ResultMedia();
    file(dir, "chart.png", 1024);
    const first = media.stage("chart.png", dir, "draft");
    assert.ok(first.ok);
    // Regenerated, bigger, new caption — one attachment, not two, and the newest wins.
    file(dir, "chart.png", 4096);
    const second = media.stage(join(dir, "chart.png"), dir, "final");
    assert.ok(second.ok);
    assert.equal(media.list().length, 1);
    assert.equal(media.list()[0].size, 4096);
    assert.equal(media.list()[0].caption, "final");
    assert.equal(media.totalBytes(), 4096);
  });
});

test("stage: a caption is bounded — it is model-authored text heading for a UI", () => {
  withDir((dir) => {
    file(dir, "x.png", 64);
    const res = new ResultMedia().stage("x.png", dir, "  " + "y".repeat(500) + "  ");
    assert.ok(res.ok);
    assert.equal(res.item.caption?.length, 200);
  });
});

test("brief: only written for a result that reaches the Inbox", () => {
  assert.equal(deliveryBrief({ inbox: false, canAttach: false }), "");
  assert.equal(withBrief("summarise my PRs", { inbox: false, canAttach: false }), "summarise my PRs");
});

test("brief: names the artifact fences the app can actually render", () => {
  const brief = deliveryBrief({ inbox: true, canAttach: false });
  assert.match(brief, /```html/);
  assert.match(brief, /kind=pdf/);
  assert.match(brief, /kind=sheet/);
  // The whole reason it exists: nobody is at the terminal.
  assert.match(brief, /Nobody is at this terminal/);
});

test("brief: describes the chart fence, which is a headless run's ONLY route to a chart", () => {
  // With no controller attached the create_chart tool isn't registered and the outbox
  // seal is write-only, so this fence is the entire mechanism. A model that doesn't know
  // it exists will never produce one.
  const brief = deliveryBrief({ inbox: true, canAttach: false });
  assert.match(brief, /```chart/);
  assert.match(brief, /"kind":"note"/);
  assert.match(brief, /"kind":"answer"/);
  // The two constraints most likely to be broken: inventing card kinds, and doing layout.
  assert.match(brief, /Two card kinds only/);
  assert.match(brief, /do NOT give positions/);
  // And the one that keeps charts from being made out of answers that aren't charts.
  assert.match(brief, /A linear answer is not a chart/);
});

test("brief: the chart example parses as the spec the app will accept", () => {
  // The example is the only schema the model gets, so a typo in it is a feature that
  // silently never works. Pull it back out and check it is real JSON of the right shape.
  const brief = deliveryBrief({ inbox: true, canAttach: false });
  const line = brief.split("\n").find((l) => l.includes("```chart") && l.includes('"nodes"'))!;
  const json = line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1);
  const spec = JSON.parse(json) as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  assert.equal(spec.nodes.length, 2);
  assert.equal(spec.nodes[0].kind, "note");
  assert.ok(spec.nodes[0].body, "the note card must carry `body`");
  assert.equal(spec.nodes[1].kind, "answer");
  assert.ok(spec.nodes[1].prompt && spec.nodes[1].answer, "the answer card must carry both halves");
  assert.equal(spec.nodes[1].parent, spec.nodes[0].ref);
  assert.equal(spec.edges[0].from, spec.nodes[0].ref);
});

test("brief: mentions attach_to_result ONLY when the tool is registered", () => {
  assert.doesNotMatch(deliveryBrief({ inbox: true, canAttach: false }), /attach_to_result/);
  assert.match(deliveryBrief({ inbox: true, canAttach: true }), /attach_to_result/);
});

test("brief: the user's prompt survives verbatim, fenced off from the brief", () => {
  const prompt = "summarise my open PRs";
  const combined = withBrief(prompt, { inbox: true, canAttach: true });
  assert.ok(combined.endsWith(`---\n\n${prompt}`));
  assert.ok(combined.startsWith("[Privateer delivery brief"));
});
