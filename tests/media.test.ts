import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEDIA_TOOL_NAMES,
  generateImageToolDefinition,
  generateVideoToolDefinition,
  generateSpeechToolDefinition,
  generateMusicToolDefinition,
  mediaCapabilitiesToolDefinition,
} from "../src/tools/media.ts";
import { COMPOSE_TOOL_NAMES, videoComposeToolDefinition } from "../src/tools/videoCompose.ts";
import { classifyToolCall } from "../src/permissions/classify.ts";

function scratch(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "pv-media-"));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

async function callCompose(cwd: string, params: unknown): Promise<string> {
  const res = (await videoComposeToolDefinition.execute("t", params as never, undefined, undefined, { cwd })) as {
    content: { text: string }[];
  };
  return res.content[0].text;
}

async function callMedia(tool: { execute: Function }, cwd: string, params: unknown): Promise<string> {
  const res = (await tool.execute("t", params, undefined, undefined, { cwd })) as { content: { text: string }[] };
  return res.content[0].text;
}

// ── Registration surface ─────────────────────────────────────────────────────
// The allow-list arrays in harbor/channels/acp are built from these constants, so a
// tool renamed without updating them would silently stop being grantable.

test("the exported tool-name lists match the registered definitions", () => {
  assert.deepEqual(
    [...MEDIA_TOOL_NAMES],
    [
      generateImageToolDefinition,
      generateVideoToolDefinition,
      generateSpeechToolDefinition,
      generateMusicToolDefinition,
      mediaCapabilitiesToolDefinition,
    ].map((d) => d.name),
  );
  assert.deepEqual([...COMPOSE_TOOL_NAMES], [videoComposeToolDefinition.name]);
});

// ── Permission classification ────────────────────────────────────────────────
// Media generation spends the user's money and writes a file. It must classify as a
// WRITE against the named output path — not fall through to the unknown-tool branch,
// which would prompt with a JSON blob and deny outright in plan mode.

test("media generation classifies as a write against its output path", () => {
  const { cwd, cleanup } = scratch();
  try {
    // The classifier canonicalizes symlinks (macOS /tmp → /private/tmp), so compare
    // against the real path rather than the one mkdtemp handed back.
    const real = realpathSync(cwd);
    for (const name of ["generate_image", "generate_video", "generate_speech", "generate_music", "video_compose"]) {
      const req = classifyToolCall(name, { prompt: "x", path: "out/thing.png", output: "out/thing.mp4" }, { cwd });
      assert.ok(req, `${name} must be gated`);
      assert.equal(req.kind, "write", `${name} should classify as a write`);
      assert.equal(req.outside, false, `${name} writes inside cwd and should not be flagged outside`);
      assert.ok(req.path?.startsWith(real), `${name} should resolve its target inside cwd (got ${req.path})`);
    }
  } finally {
    cleanup();
  }
});

test("an input image from outside the working directory prompts even when the output is inside", () => {
  const { cwd, cleanup } = scratch();
  try {
    const req = classifyToolCall("generate_image", { prompt: "x", path: "out.png", images: ["/etc/hosts"] }, { cwd });
    assert.ok(req);
    assert.equal(req.outside, true);
    assert.match(req.detail, /outside the working directory/);
  } finally {
    cleanup();
  }
});

test("a media write outside the working directory is flagged as outside", () => {
  const req = classifyToolCall("generate_image", { prompt: "x", path: "/etc/evil.png" }, { cwd: "/tmp/project" });
  assert.ok(req);
  assert.equal(req.outside, true);
});

test("media_capabilities needs no gate — it reads the account's own settings and costs nothing", () => {
  assert.equal(classifyToolCall("media_capabilities", {}, { cwd: "/tmp/project" }), null);
});

// ── Local validation (no network) ────────────────────────────────────────────
// Everything below fails before any account call, so it runs offline and never bills.

test("generation tools refuse an empty prompt or a missing path", async () => {
  const { cwd, cleanup } = scratch();
  try {
    assert.match(await callMedia(generateImageToolDefinition, cwd, { prompt: "  ", path: "a.png" }), /prompt is required/);
    assert.match(await callMedia(generateImageToolDefinition, cwd, { prompt: "a cat", path: "" }), /path is required/);
    assert.match(await callMedia(generateVideoToolDefinition, cwd, { prompt: "", path: "a.mp4" }), /prompt is required/);
    assert.match(await callMedia(generateSpeechToolDefinition, cwd, { text: "", path: "a.mp3" }), /text is required/);
    assert.match(await callMedia(generateMusicToolDefinition, cwd, { prompt: "", path: "a.mp3" }), /prompt is required/);
  } finally {
    cleanup();
  }
});

test("generate_video rejects a lastFrame with no firstFrame before spending anything", async () => {
  const { cwd, cleanup } = scratch();
  try {
    const out = await callMedia(generateVideoToolDefinition, cwd, { prompt: "x", path: "a.mp4", lastFrame: "b.png" });
    assert.match(out, /lastFrame needs firstFrame/);
  } finally {
    cleanup();
  }
});

test("a missing input image is reported locally, not sent upstream", async () => {
  const { cwd, cleanup } = scratch();
  try {
    const out = await callMedia(generateImageToolDefinition, cwd, { prompt: "x", path: "a.png", images: ["nope.png"] });
    assert.match(out, /input image not found: nope\.png/);
  } finally {
    cleanup();
  }
});

test("an empty input image is rejected rather than uploaded as zero bytes", async () => {
  const { cwd, cleanup } = scratch();
  try {
    writeFileSync(join(cwd, "empty.png"), "");
    const out = await callMedia(generateImageToolDefinition, cwd, { prompt: "x", path: "a.png", images: ["empty.png"] });
    assert.match(out, /empty/);
  } finally {
    cleanup();
  }
});

test("video_compose rejects an unknown operation by name", async () => {
  const { cwd, cleanup } = scratch();
  try {
    const out = await callCompose(cwd, { operation: "explode", input: "a.mp4" });
    assert.match(out, /unknown operation "explode"/);
    assert.match(out, /probe, concat, slideshow/);
  } finally {
    cleanup();
  }
});

test("video_compose names the missing parameter instead of failing inside ffmpeg", async () => {
  const { cwd, cleanup } = scratch();
  try {
    assert.match(await callCompose(cwd, { operation: "concat", inputs: ["a.mp4"] }), /at least two paths/);
    assert.match(await callCompose(cwd, { operation: "mux_audio", input: "a.mp4" }), /needs `audio`/);
    assert.match(await callCompose(cwd, { operation: "trim" }), /needs `input`/);
    assert.match(await callCompose(cwd, { operation: "probe" }), /needs `input`/);
  } finally {
    cleanup();
  }
});

// ── Real ffmpeg round trip ───────────────────────────────────────────────────
// The filter graphs are the part that can't be reasoned about on paper: mixed sizes,
// mixed frame rates and a clip with no audio meeting one that has some are the exact
// combination a generated-clip workflow produces, and the exact combination a naive
// concat fails on. Skipped where ffmpeg isn't installed rather than failing the suite.

test("video_compose stitches, scores and samples real files", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, async () => {
  const { cwd, cleanup } = scratch();
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd });
  try {
    // 3s @ 640x360 @ 30fps WITH audio; 2s @ 320x240 @ 24fps WITHOUT.
    ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "a.mp4"]);
    ff(["-f", "lavfi", "-i", "smptebars=size=320x240:rate=24:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "b.mp4"]);
    ff(["-f", "lavfi", "-i", "color=c=red:size=800x600:duration=1", "-frames:v", "1", "s1.png"]);
    ff(["-f", "lavfi", "-i", "color=c=blue:size=640x480:duration=1", "-frames:v", "1", "s2.png"]);
    ff(["-f", "lavfi", "-i", "sine=frequency=220:duration=2", "tone.mp3"]);

    const probed = await callCompose(cwd, { operation: "probe", inputs: ["a.mp4", "b.mp4"] });
    assert.match(probed, /a\.mp4: 3\.00s, 640x360.*audio: yes/);
    assert.match(probed, /b\.mp4: 2\.00s, 320x240.*audio: no/);

    // Hard cut: 3s + 2s, normalized to the first clip's grid, silence filled in for b.
    const cut = await callCompose(cwd, { operation: "concat", inputs: ["a.mp4", "b.mp4"], output: "cut.mp4" });
    assert.match(cut, /Stitched 2 clips/);
    assert.match(cut, /640x360, 30 fps/);
    assert.ok(existsSync(join(cwd, "cut.mp4")));

    // Crossfade eats one overlap: 3 + 2 - 1 = 4s.
    const xf = await callCompose(cwd, { operation: "concat", inputs: ["a.mp4", "b.mp4"], output: "xf.mp4", crossfadeSeconds: 1 });
    assert.match(xf, /with 1s crossfades/);
    assert.match(xf, /\(4\.\d\ds/);

    // A crossfade longer than a clip is a graph that would hang or produce garbage.
    assert.match(
      await callCompose(cwd, { operation: "concat", inputs: ["a.mp4", "b.mp4"], output: "no.mp4", crossfadeSeconds: 5 }),
      /longer than clip/,
    );

    const slides = await callCompose(cwd, {
      operation: "slideshow", inputs: ["s1.png", "s2.png"], output: "slides.mp4",
      secondsPerImage: 2, crossfadeSeconds: 0.5, size: "1280x720",
    });
    assert.match(slides, /3\.5\ds slideshow/);
    assert.match(slides, /no audio/);

    const scored = await callCompose(cwd, { operation: "mux_audio", input: "slides.mp4", audio: "tone.mp3", output: "scored.mp4", loopAudio: true, volume: 0.4 });
    assert.match(scored, /looped/);
    // -shortest must bound the looped track to the video, not the other way round.
    assert.match(scored, /\(3\.5\ds\)/);

    const mixed = await callCompose(cwd, { operation: "mux_audio", input: "a.mp4", audio: "tone.mp3", output: "mixed.mp4", keepOriginalAudio: true });
    assert.match(mixed, /mixed with the original audio/);

    const trimmed = await callCompose(cwd, { operation: "trim", input: "cut.mp4", output: "short.mp4", start: 1, duration: 1.5 });
    assert.match(trimmed, /\(1\.5\ds\)/);

    // "last" must land just inside the clip — seeking to the exact duration writes
    // no frame at all, which is how this silently produced empty files.
    const last = await callCompose(cwd, { operation: "extract_frame", input: "a.mp4", output: "last.png", at: "last" });
    assert.match(last, /Extracted the frame at 2\.9\ds/);
    assert.ok(existsSync(join(cwd, "last.png")));

    assert.match(await callCompose(cwd, { operation: "extract_frame", input: "a.mp4", output: "mid.jpg", at: 1 }), /at 1\.00s/);
    assert.match(await callCompose(cwd, { operation: "extract_frame", input: "a.mp4", output: "x.png", at: 99 }), /past the end/);

    assert.match(await callCompose(cwd, { operation: "gif", input: "a.mp4", output: "out.gif", start: 0.5, duration: 1, fps: 10, size: "320x240" }), /GIF/);
    assert.ok(existsSync(join(cwd, "out.gif")));
  } finally {
    cleanup();
  }
});

test("video_compose says ffmpeg is missing rather than surfacing ENOENT", async () => {
  const { cwd, cleanup } = scratch();
  const prev = process.env.PRIVATEER_FFMPEG;
  const prevProbe = process.env.PRIVATEER_FFPROBE;
  try {
    writeFileSync(join(cwd, "a.mp4"), "not really a video");
    process.env.PRIVATEER_FFMPEG = "definitely-not-a-real-binary";
    process.env.PRIVATEER_FFPROBE = "definitely-not-a-real-binary";
    const out = await callCompose(cwd, { operation: "trim", input: "a.mp4", output: "b.mp4", start: 0 });
    assert.match(out, /ffmpeg is not installed/);
    assert.match(out, /PRIVATEER_FFMPEG/);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_FFMPEG;
    else process.env.PRIVATEER_FFMPEG = prev;
    if (prevProbe === undefined) delete process.env.PRIVATEER_FFPROBE;
    else process.env.PRIVATEER_FFPROBE = prevProbe;
    cleanup();
  }
});
