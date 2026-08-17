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
  generateModelToolDefinition,
  generateSpeechToolDefinition,
  generateMusicToolDefinition,
  generateSfxToolDefinition,
  mediaCapabilitiesToolDefinition,
  describeModel3d,
  describeSfx,
} from "../src/tools/media.ts";
import {
  COMPOSE_TOOL_NAMES,
  videoComposeToolDefinition,
  parseSubtitleCues,
  wrapLines,
} from "../src/tools/videoCompose.ts";
import { classifyToolCall } from "../src/permissions/classify.ts";
import { decideAuto } from "../src/permissions/mode.ts";

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
      generateModelToolDefinition,
      generateSpeechToolDefinition,
      generateMusicToolDefinition,
      generateSfxToolDefinition,
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
    for (const name of ["generate_image", "generate_video", "generate_model", "generate_speech", "generate_music", "generate_sfx", "video_compose"]) {
      const req = classifyToolCall(name, { prompt: "x", path: "out/thing.png", output: "out/thing.mp4" }, { cwd });
      assert.ok(req, `${name} must be gated`);
      assert.equal(req.kind, "write", `${name} should classify as a write`);
      assert.equal(req.outside, false, `${name} writes inside cwd and should not be flagged outside`);
      assert.ok(req.path?.startsWith(real), `${name} should resolve its target inside cwd (got ${req.path})`);
      // The billed, egressing generation tools carry alwaysAsk so acceptEdits/bypass
      // can't swallow them; local video_compose does not.
      const isGen = name !== "video_compose";
      assert.equal(!!req.alwaysAsk, isGen, `${name} alwaysAsk should be ${isGen}`);
    }
  } finally {
    cleanup();
  }
});

test("generation tools are NOT auto-allowed under acceptEdits/bypass; video_compose is", () => {
  const { cwd, cleanup } = scratch();
  try {
    for (const name of ["generate_image", "generate_video", "generate_speech", "generate_music", "generate_sfx"]) {
      const req = classifyToolCall(name, { prompt: "x", path: "out/thing.png" }, { cwd });
      assert.ok(req);
      // alwaysAsk sits above every auto-allow: acceptEdits, bypass and no-quarter.
      assert.equal(decideAuto(req, "acceptEdits", []), "ask", `${name} must ask under acceptEdits`);
      assert.equal(decideAuto(req, "bypass", []), "ask", `${name} must ask under bypass`);
    }
    const compose = classifyToolCall("video_compose", { output: "out/clip.mp4", inputs: ["a.png"] }, { cwd });
    assert.ok(compose);
    assert.equal(decideAuto(compose, "acceptEdits", []), "allow", "local video_compose still auto-allows under acceptEdits");
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

test("a protected input file (e.g. .env) is flagged protected and named, even with an in-cwd output", () => {
  const { cwd, cleanup } = scratch();
  try {
    const req = classifyToolCall("generate_image", { prompt: "x", path: "thumb.png", images: [".env"] }, { cwd });
    assert.ok(req);
    assert.equal(req.protected, true, "reading a protected file as input must set protected");
    assert.equal(req.outside, false, "the .env is inside cwd — only protected, not outside");
    assert.match(req.detail, /protected file/, "the dialog must name the protected input, not just the output");
    // protected forces a prompt above acceptEdits/allowlist for EVERY media tool...
    assert.equal(decideAuto(req, "acceptEdits", []), "ask");
  } finally {
    cleanup();
  }
});

test("video_compose reading a protected input prompts under acceptEdits (it has no alwaysAsk)", () => {
  const { cwd, cleanup } = scratch();
  try {
    const req = classifyToolCall("video_compose", { output: "out/clip.mp4", audio: ".env" }, { cwd });
    assert.ok(req);
    assert.equal(req.protected, true);
    // ...including local video_compose, which is not alwaysAsk — protected is what saves it.
    assert.equal(decideAuto(req, "acceptEdits", []), "ask");
  } finally {
    cleanup();
  }
});

// mix_audio's paths live INSIDE objects, one per placed track, and overlay_text's font
// is its own parameter. Both are read from disk by the tool, so both must reach the
// classifier — a nested path it cannot see is a path the gate never judges.

test("mix_audio's per-track paths are classified, even though they are nested in objects", () => {
  const { cwd, cleanup } = scratch();
  try {
    const req = classifyToolCall(
      "video_compose",
      {
        operation: "mix_audio",
        input: "cut.mp4",
        output: "final.mp4",
        tracks: [{ path: "audio/vo.mp3" }, { path: "/etc/hosts", gain: 0.3 }],
      },
      { cwd },
    );
    assert.ok(req);
    assert.equal(req.outside, true, "a track from outside cwd must be flagged");
    assert.match(req.detail, /\/etc\/hosts/, "the dialog has to name the file being read");
  } finally {
    cleanup();
  }
});

test("a protected file passed as a mix_audio track is flagged protected", () => {
  const { cwd, cleanup } = scratch();
  try {
    // A bare string is a legal track, so it has to be classified like an object one.
    const req = classifyToolCall("video_compose", { operation: "mix_audio", input: "a.mp4", output: "b.mp4", tracks: [".env"] }, { cwd });
    assert.ok(req);
    assert.equal(req.protected, true);
    assert.equal(decideAuto(req, "acceptEdits", []), "ask");
  } finally {
    cleanup();
  }
});

test("overlay_image's per-layer paths are classified, in both shapes it accepts", () => {
  const { cwd, cleanup } = scratch();
  try {
    // `images` is a list of PATHS for generate_video's reference stills and a list of
    // OBJECTS for overlay_image's layers. One name, two shapes, and the tool opens
    // whichever arrives — so the classifier has to resolve whichever arrives.
    const nested = classifyToolCall(
      "video_compose",
      { operation: "overlay_image", input: "cut.mp4", output: "final.mp4", images: [{ path: "brand/logo.png" }, { path: "/etc/hosts" }] },
      { cwd },
    );
    assert.ok(nested);
    assert.equal(nested.outside, true, "a layer from outside cwd must be flagged");
    assert.match(nested.detail, /\/etc\/hosts/);

    const bare = classifyToolCall(
      "video_compose",
      { operation: "overlay_image", input: "a.mp4", output: "b.mp4", images: [".env"] },
      { cwd },
    );
    assert.ok(bare);
    assert.equal(bare.protected, true, "a bare string is a legal layer, so it is classified like an object one");
    assert.equal(decideAuto(bare, "acceptEdits", []), "ask");

    // The generate_video shape must keep working — same key, plain strings.
    const refs = classifyToolCall("generate_video", { prompt: "x", path: "out.mp4", images: ["/etc/hosts"] }, { cwd });
    assert.ok(refs);
    assert.equal(refs.outside, true);
  } finally {
    cleanup();
  }
});

test("burn_subtitles' subtitle file is classified as a read", () => {
  const { cwd, cleanup } = scratch();
  try {
    const req = classifyToolCall(
      "video_compose",
      { operation: "burn_subtitles", input: "a.mp4", output: "b.mp4", subtitles: "/tmp/elsewhere/captions.srt" },
      { cwd },
    );
    assert.ok(req);
    assert.equal(req.outside, true, "a whole file is read into the picture; where it comes from is the user's call");
    assert.match(req.detail, /captions\.srt/);
  } finally {
    cleanup();
  }
});

test("overlay_text's fontFile is classified as a read", () => {
  const { cwd, cleanup } = scratch();
  try {
    const req = classifyToolCall(
      "video_compose",
      { operation: "overlay_text", input: "a.mp4", output: "b.mp4", fontFile: "/etc/fonts/x.ttf", texts: [{ text: "hi" }] },
      { cwd },
    );
    assert.ok(req);
    assert.equal(req.outside, true);
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
    assert.match(await callMedia(generateSfxToolDefinition, cwd, { prompt: "", path: "a.mp3" }), /prompt is required/);
    assert.match(await callMedia(generateSfxToolDefinition, cwd, { prompt: "a door", path: "" }), /path is required/);
  } finally {
    cleanup();
  }
});

// ── generate_sfx ─────────────────────────────────────────────────────────────
// The server CLAMPS a length outside its model's range rather than refusing it, which
// is right for a slider and wrong for an agent: a model that asked for 45s of rain and
// silently got 30 cuts the sequence to a length that doesn't exist. So the bound is
// enforced locally, by name, before anything is billed.

test("generate_sfx refuses a length no effect model can produce, before spending", async () => {
  const { cwd, cleanup } = scratch();
  try {
    for (const seconds of [0, 0.5, 31, 120]) {
      const out = await callMedia(generateSfxToolDefinition, cwd, { prompt: "rain", path: "a.mp3", seconds });
      assert.match(out, /seconds must be between 1 and 30/, `${seconds}s should be refused locally`);
      // And it must say what to do instead, or the model just retries with 29.
      assert.match(out, /generate_music|mix_audio/, "the refusal should point at the tool that covers a longer sound");
    }
  } finally {
    cleanup();
  }
});

test("generate_sfx states its ZDR posture, and does not offer music as the private alternative", () => {
  const d = generateSfxToolDefinition.description;
  // The distinction is the easy one to get backwards: sfx IS gated (fal is non-ZDR),
  // music is NOT gated at all. Telling a user to use music for privacy is the exact
  // wrong advice, so the description has to close that door explicitly.
  assert.match(d, /Require ZDR/i, "a ZDR account is refused — the model must know before it plans a sequence");
  assert.match(d, /do not retry/i, "only the account owner can change it");
  assert.match(d, /ungated|no ZDR gate|looser/i, "it must say music is looser, not safer");
});

test("the sfx report separates a missing provider key from the account's own privacy setting", () => {
  // Different refusals, different remedies — and only one of them is the user's to fix.
  const unconfigured = describeSfx({ configured: false }).join("\n");
  assert.match(unconfigured, /NOT AVAILABLE/);
  assert.match(unconfigured, /Do not call generate_sfx/);

  const blocked = describeSfx({ model: "fal-ai/stable-audio-3/small/sfx/text-to-audio", configured: true, blockedByZdr: true }).join("\n");
  assert.match(blocked, /BLOCKED by this account's ZDR setting/);
  assert.match(blocked, /Settings → Privacy/);
  assert.match(blocked, /Do not substitute generate_music/, "the ungated tool must not read as the safe fallback");

  const ok = describeSfx({ model: "fal-ai/elevenlabs/sound-effects/v2", configured: true, blockedByZdr: false, maxDurationSeconds: 30 }).join("\n");
  assert.match(ok, /fal-ai\/elevenlabs\/sound-effects\/v2/);
  assert.match(ok, /up to 30s/);
  assert.doesNotMatch(ok, /BLOCKED/);
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

// ── generate_model ───────────────────────────────────────────────────────────
// A mesh is the dearest call this file registers, so everything that can be
// refused locally must be — a request rejected by the provider is still a round
// trip, and a request rejected by our own server after the reservation is a
// reservation to unwind.

test("generate_model refuses a call with no reference image", async () => {
  const { cwd, cleanup } = scratch();
  try {
    // There is no text-to-mesh path, so this is a hard refusal rather than a
    // fallback — and the message has to say what to do instead.
    const out = await callMedia(generateModelToolDefinition, cwd, { images: [], path: "a.glb" });
    assert.match(out, /at least one reference image is required/i);
    assert.match(out, /generate_image/, "the refusal should name the tool that produces the input");
  } finally {
    cleanup();
  }
});

test("generate_model refuses more views than the provider takes", async () => {
  const { cwd, cleanup } = scratch();
  try {
    for (const n of [1, 2, 3, 4, 5]) {
      const names = Array.from({ length: n }, (_, i) => `v${i}.png`);
      for (const name of names) writeFileSync(join(cwd, name), "x");
      const out = await callMedia(generateModelToolDefinition, cwd, { images: names, path: "a.glb" });
      // 1-4 views get past validation and fail at the (unauthenticated) account
      // call; 5 is refused locally by name.
      if (n > 4) assert.match(out, /at most 4 reference views/i, `${n} views should be refused locally`);
      else assert.doesNotMatch(out, /at most 4 reference views/i, `${n} views should be allowed`);
    }
  } finally {
    cleanup();
  }
});

test("generate_model needs a path, and reports a missing view locally", async () => {
  const { cwd, cleanup } = scratch();
  try {
    writeFileSync(join(cwd, "front.png"), "x");
    assert.match(await callMedia(generateModelToolDefinition, cwd, { images: ["front.png"], path: "" }), /path is required/);
    assert.match(
      await callMedia(generateModelToolDefinition, cwd, { images: ["nope.png"], path: "a.glb" }),
      /input image not found: nope\.png/,
    );
  } finally {
    cleanup();
  }
});

test("generate_model's permission prompt names every reference view", async () => {
  const { cwd, cleanup } = scratch();
  try {
    const real = realpathSync(cwd);
    // The inputs are base64'd up to our servers, so the human approving the
    // spend has to see which files are being read — the same reason
    // generate_image's `images` feed the classifier.
    const req = classifyToolCall(
      "generate_model",
      { images: ["concept/front.png", "concept/back.png"], path: "assets/crate.glb" },
      { cwd },
    );
    assert.ok(req, "generate_model must be gated");
    assert.equal(req.kind, "write");
    assert.ok(req.alwaysAsk, "a mesh is billed egress and must never be auto-approved");
    assert.ok(req.path?.startsWith(real));
    // And the title has to carry the cost — this is the priciest tool here.
    assert.match(req.title ?? "", /3D model/i);
    assert.match(req.title ?? "", /\$/, "the prompt should state what a mesh costs");
  } finally {
    cleanup();
  }
});

// ── 3D: many models, each with its own options ───────────────────────────────
// The catalog behind generate_model is ten endpoints from five vendors whose
// options do not overlap, and the agent has no picker: everything it can know
// about which model to use and what to pass it arrives through
// media_capabilities. These pin the two halves of that — discovery, and the
// free-form `axes` object that carries the choice back.

test("generate_model takes a free-form axes object, in a schema every provider accepts", () => {
  const axes = generateModelToolDefinition.parameters.properties.axes as unknown as Record<string, unknown>;
  assert.ok(axes, "generate_model must accept `axes` or nine of the ten models are unreachable");
  assert.equal(axes.type, "object");
  // TypeBox's Record spelling compiles to `patternProperties`, which several
  // providers' tool-schema validators reject — and a refused schema fails at the
  // provider with a message about JSON Schema rather than about 3D.
  assert.ok(!("patternProperties" in axes), "axes must not use patternProperties");
  assert.ok(axes.additionalProperties, "axes must allow arbitrary option names");
  assert.ok(
    !(generateModelToolDefinition.parameters.required as string[]).includes("axes"),
    "axes must stay optional — the Hunyuan models are still driven by the named fields",
  );
});

test("generate_model's description sends the model to capabilities before it spends", () => {
  const d = generateModelToolDefinition.description;
  assert.match(d, /media_capabilities/, "the model has no other way to learn a model's options");
  assert.match(d, /\$0\.14/, "the floor of the catalog, not of one model");
  assert.match(d, /\$2\.41/, "the ceiling of the catalog, not of one model");
});

test("media_capabilities can be pointed at a specific 3D model", () => {
  const props = mediaCapabilitiesToolDefinition.parameters.properties as Record<string, unknown>;
  assert.ok(props.model, "without this the agent can only ever read the default model's options");
});

test("the 3D report describes the model it will actually call, and every model it could", () => {
  const lines = describeModel3d({
    model: "fal-ai/trellis-2",
    configured: true,
    blockedByZdr: false,
    formats: ["glb"],
    maxViews: 1,
    priceUsd: { min: 0.35, max: 0.49 },
    axes: [
      { name: "resolution", kind: "enum", priced: true, default: "1024", values: ["512", "1024", "1536"] },
      { name: "faceCount", kind: "int", priced: false, min: 5000, max: 2000000 },
    ],
    conflicts: [{ whenAxis: "texture", is: "no", forbids: "pbr" }],
    catalog: [
      { id: "fal-ai/trellis-2", name: "Trellis 2", priceUsd: { min: 0.35, max: 0.49 } },
      { id: "fal-ai/hyper3d/rodin/v2.5/fast", name: "Rodin v2.5 Fast", priceUsd: { min: 0.14, max: 0.14 } },
    ],
  });
  const out = lines.join("\n");

  // The options named must be THIS model's. Printing a different endpoint's
  // levers is the expensive failure: the call is refused after the model has
  // already planned around them, or worse, silently priced differently.
  assert.match(out, /resolution: 512 \| 1024 \| 1536/);
  assert.match(out, /\[affects price\]/, "a priced option must be marked as one");
  assert.match(out, /faceCount: number 5000-2000000/);
  assert.doesNotMatch(out, /generateType|polygonType/, "Trellis has neither — naming them would invite a refused call");
  assert.match(out, /pbr cannot be used when texture is "no"/);

  // And every id, or the other nine models may as well not exist.
  assert.match(out, /fal-ai\/hyper3d\/rodin\/v2\.5\/fast \$0\.14-\$0\.14/);
  assert.match(out, /fal-ai\/trellis-2 \$0\.35-\$0\.49\s+\[described above\]/);
});

test("an unconfigured deployment says so instead of listing options nobody can use", () => {
  const lines = describeModel3d({ configured: false });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /NOT AVAILABLE/);
  assert.match(lines[0], /Do not call generate_model/);
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
    assert.match(await callCompose(cwd, { operation: "mix_audio", input: "a.mp4", output: "b.mp4" }), /at least one entry in `tracks`/);
    assert.match(await callCompose(cwd, { operation: "mix_audio", output: "b.mp4", tracks: ["x.mp3"] }), /needs `input`/);
    assert.match(await callCompose(cwd, { operation: "overlay_text", input: "a.mp4", output: "b.mp4" }), /at least one entry in `texts`/);
    assert.match(await callCompose(cwd, { operation: "overlay_text", output: "b.mp4", texts: [{ text: "hi" }] }), /needs `input`/);
    // Ducking with nothing to duck under is a graph that would build and do nothing.
    assert.match(
      await callCompose(cwd, { operation: "mix_audio", input: "a.mp4", output: "b.mp4", tracks: [{ path: "x.mp3", duck: true }] }),
      /`duck` needs `voiceTrack`/,
    );
    assert.match(
      await callCompose(cwd, { operation: "mix_audio", input: "a.mp4", output: "b.mp4", tracks: ["x.mp3"], voiceTrack: 4 }),
      /must be the index of one of the 1 track/,
    );
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

// ── mix_audio and overlay_text, measured ─────────────────────────────────────
// These two exist for exactly two claims — an effect lands on the frame it was placed
// on, and a bed gets out of the way of narration — and both are claims about the AUDIO,
// which a passing exit code says nothing about. So the output is measured rather than
// merely produced: silencedetect for the placement, and the bed's own frequency band
// for the duck.

function ffStderr(cwd: string, args: string[]): string {
  // ffmpeg reports filter measurements on stderr and exits 0, so the analysis output
  // has to be captured rather than inherited.
  return String(spawnSync("ffmpeg", ["-hide_banner", ...args], { cwd, encoding: "utf8" }).stderr ?? "");
}

test("mix_audio places a cue on its frame and ducks the bed under the voice", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, async () => {
  const { cwd, cleanup } = scratch();
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd });
  try {
    // 6s of video with its own 200 Hz tone; a 6s voice at 440 Hz; a SHORT 2s bed at
    // 110 Hz (so looping is exercised); a 1s cue at 880 Hz.
    ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=200:duration=6",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "base.mp4"]);
    ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=6", "vo.mp3"]);
    ff(["-f", "lavfi", "-i", "sine=frequency=110:duration=2", "bed.mp3"]);
    ff(["-f", "lavfi", "-i", "sine=frequency=880:duration=1", "cue.mp3"]);

    // A cue at 3.2s and nothing else: the mix must be silent until then. This is the
    // whole reason mix_audio exists — mux_audio can only start a track at zero.
    const placed = await callCompose(cwd, {
      operation: "mix_audio", input: "base.mp4", output: "placed.mp4", tracks: [{ path: "cue.mp3", atSeconds: 3.2 }],
    });
    assert.match(placed, /at 3\.2s/);
    const silence = ffStderr(cwd, ["-i", "placed.mp4", "-af", "silencedetect=noise=-40dB:d=0.2", "-f", "null", "-"]);
    const end = Number(/silence_end: ([\d.]+)/.exec(silence)?.[1]);
    assert.ok(Math.abs(end - 3.2) < 0.1, `the cue should start at 3.2s, silence ended at ${end}`);

    // The same bed under the same voice, ducked and not. Measured in the bed's own
    // band so the voice doesn't dominate the reading.
    const bedBand = async (out: string, duck: boolean) => {
      await callCompose(cwd, {
        operation: "mix_audio", input: "base.mp4", output: out, voiceTrack: 0,
        tracks: [{ path: "vo.mp3" }, { path: "bed.mp3", gain: 0.35, loop: true, duck }],
      });
      const measured = ffStderr(cwd, ["-i", out, "-af", "bandpass=f=110:width_type=h:w=40,volumedetect", "-f", "null", "-"]);
      return Number(/mean_volume: (-?[\d.]+) dB/.exec(measured)?.[1]);
    };
    const loud = await bedBand("duck-off.mp4", false);
    const quiet = await bedBand("duck-on.mp4", true);
    assert.ok(Number.isFinite(loud) && Number.isFinite(quiet), `could not measure the bed (${loud}/${quiet})`);
    assert.ok(quiet < loud - 3, `ducking should drop the bed by more than 3 dB (got ${loud} → ${quiet})`);

    // A 2s bed looped under a 6s video must still be playing at the end — a bed that
    // simply stops partway reads as a bug, and -shortest must bound it to the video
    // rather than the video to it.
    const looped = await callCompose(cwd, { operation: "probe", input: "duck-on.mp4" });
    assert.match(looped, /6\.0\ds/);

    // keepOriginalAudio has to mix, not replace: the video's own 200 Hz tone survives.
    await callCompose(cwd, { operation: "mix_audio", input: "base.mp4", output: "kept.mp4", tracks: ["cue.mp3"], keepOriginalAudio: true });
    const orig = ffStderr(cwd, ["-i", "kept.mp4", "-af", "bandpass=f=200:width_type=h:w=40,volumedetect", "-f", "null", "-"]);
    assert.ok(Number(/mean_volume: (-?[\d.]+) dB/.exec(orig)?.[1]) > -50, "the video's own audio should still be there");

    // A silent video has no audio to keep, and saying so beats an ffmpeg graph error.
    ff(["-f", "lavfi", "-i", "color=c=black:size=320x240:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "silent.mp4"]);
    assert.match(
      await callCompose(cwd, { operation: "mix_audio", input: "silent.mp4", output: "no.mp4", tracks: ["cue.mp3"], keepOriginalAudio: true }),
      /has no audio to keep/,
    );
    // And a video passed as a track has to be rejected for the right reason.
    assert.match(
      await callCompose(cwd, { operation: "mix_audio", input: "base.mp4", output: "no.mp4", tracks: ["silent.mp4"] }),
      /has no audio stream/,
    );
  } finally {
    cleanup();
  }
});

test("overlay_text burns type in without the text being parsed as a filter", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, async () => {
  const { cwd, cleanup } = scratch();
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd });
  try {
    ff(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=300:duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "in.mp4"]);

    // EVERY character below means something to ffmpeg's filtergraph parser. They are
    // also all things a real caption contains — a ratio, a percentage, an apostrophe.
    // This passes only because the text goes to drawtext through a FILE rather than
    // into the graph as syntax.
    const nasty = "Ratio 3:1, 50% off — it's 'here'; [now]\\done";
    const out = await callCompose(cwd, {
      operation: "overlay_text", input: "in.mp4", output: "titled.mp4",
      texts: [
        { text: nasty, position: "bottom", fromSeconds: 0, toSeconds: 2, box: true, boxOpacity: 0.6 },
        { text: "Lower third", position: "bottom-left", fontSize: 22, color: "#ff8800", fromSeconds: 2 },
        { text: "%{pts}", position: "center" },
      ],
    });
    assert.match(out, /Burned 3 text overlay/);
    assert.match(out, /640x360/, "the frame size must survive the re-encode");
    assert.ok(existsSync(join(cwd, "titled.mp4")));

    // Audio is copied through, not dropped or re-encoded, when type is added.
    assert.match(await callCompose(cwd, { operation: "probe", input: "titled.mp4" }), /audio: yes/);

    // Rejections that must not reach ffmpeg: an invented position, a colour carrying
    // its own filter syntax, and a window that ends before it starts.
    assert.match(
      await callCompose(cwd, { operation: "overlay_text", input: "in.mp4", output: "x.mp4", texts: [{ text: "a", position: "middle-ish" }] }),
      /position must be one of/,
    );
    assert.match(
      await callCompose(cwd, { operation: "overlay_text", input: "in.mp4", output: "x.mp4", texts: [{ text: "a", color: "black@0.5" }] }),
      /colour name/,
    );
    assert.match(
      await callCompose(cwd, { operation: "overlay_text", input: "in.mp4", output: "x.mp4", texts: [{ text: "a", fromSeconds: 3, toSeconds: 1 }] }),
      /must be after fromSeconds/,
    );
    assert.match(
      await callCompose(cwd, { operation: "overlay_text", input: "in.mp4", output: "x.mp4", texts: [{ text: "a" }], fontFile: "nope.ttf" }),
      /fontFile not found/,
    );
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

// ── overlay_image and burn_subtitles, measured ───────────────────────────────
// Both claim something about PIXELS — a logo in that corner at that second, a caption
// that appears and goes away on the file's own timings — and a zero exit code says
// nothing about either. So the output frames are sampled.

// The brightest channel value in a small crop of one frame. Brightest rather than mean:
// a caption is thin white glyphs over a mostly-dark plate, where the mean barely moves
// but the peak is unmistakable.
function peakAt(cwd: string, file: string, t: number, x: number, y: number, size = 8): number {
  const res = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", file, "-vf", `crop=${size}:${size}:${x}:${y}`,
     "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
    { cwd, maxBuffer: 1 << 24 },
  );
  return Math.max(0, ...res.stdout);
}

// Mean red/green/blue of a crop — for asserting WHICH colour landed, not just that
// something did.
function meanRgb(cwd: string, file: string, t: number, x: number, y: number, size = 8): [number, number, number] {
  const res = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-ss", String(t), "-i", file, "-vf", `crop=${size}:${size}:${x}:${y}`,
     "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"],
    { cwd, maxBuffer: 1 << 24 },
  );
  const b = res.stdout;
  let r = 0, g = 0, bl = 0;
  for (let i = 0; i < b.length; i += 3) { r += b[i]; g += b[i + 1]; bl += b[i + 2]; }
  const n = b.length / 3;
  return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
}

test("overlay_image composites a logo where and when it was asked for", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, async () => {
  const { cwd, cleanup } = scratch();
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd });
  try {
    // Black footage, so any lit pixel is unambiguous; a pure red 100x100 mark; a plate
    // WIDER than the frame.
    ff(["-f", "lavfi", "-i", "color=c=black:size=640x360:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=300:duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "in.mp4"]);
    ff(["-f", "lavfi", "-i", "color=c=red:size=100x100", "-frames:v", "1", "logo.png"]);
    ff(["-f", "lavfi", "-i", "color=c=blue:size=900x100", "-frames:v", "1", "wide.png"]);
    ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "tone.mp3"]);

    const out = await callCompose(cwd, {
      operation: "overlay_image", input: "in.mp4", output: "logo.mp4",
      images: [
        { path: "logo.png", widthPercent: 20, position: "top-right" },
        { path: "logo.png", widthPercent: 10, position: "bottom-left", fromSeconds: 2, toSeconds: 3.5, opacity: 0.5 },
      ],
    });
    assert.match(out, /Composited 2 image/);
    assert.match(out, /128px wide/, "widthPercent is resolved against the frame, not the art");

    // widthPercent 20 of 640 = 128 wide; the default margin is 3% of 640 = 19. So the
    // mark spans x 493-621, y 19-147 — and (550,70) is inside it.
    assert.deepEqual(meanRgb(cwd, "logo.mp4", 1, 550, 70), [252, 0, 0], "the mark should be red in its corner");
    assert.equal(peakAt(cwd, "logo.mp4", 1, 300, 200), 0, "and nowhere else");

    // A still must be LOOPED for the video's length. Before the fix for this, ffprobe's
    // fabricated 25fps for a PNG made the loop look unnecessary and the mark appeared on
    // frame 1 alone — which a check at t=0 would have missed entirely.
    assert.ok(peakAt(cwd, "logo.mp4", 3.9, 550, 70) > 200, "the mark should still be there at the end");

    // The windowed second layer: absent before its cue, and at HALF strength inside it.
    // 10% of 640 = 64 wide at bottom-left → x 19-83, y 277-341.
    assert.equal(peakAt(cwd, "logo.mp4", 1, 40, 300), 0, "not before fromSeconds");
    assert.deepEqual(meanRgb(cwd, "logo.mp4", 2.5, 40, 300), [127, 0, 0], "opacity 0.5 over black is half red");
    assert.equal(peakAt(cwd, "logo.mp4", 3.8, 40, 300), 0, "gone after toSeconds");

    // The film must not be truncated to the length of its logo, and its sound is copied.
    assert.match(await callCompose(cwd, { operation: "probe", input: "logo.mp4" }), /4\.0\ds, 640x360.*audio: yes/);

    // Art wider than the frame is shrunk to fit rather than silently cropped.
    const wide = await callCompose(cwd, { operation: "overlay_image", input: "in.mp4", output: "wide.mp4", images: ["wide.png"] });
    assert.match(wide, /640px wide/, "a bare string is accepted, and over-wide art is fitted");
    assert.deepEqual(meanRgb(cwd, "wide.mp4", 1, 300, 30), [0, 0, 254]);

    // Rejections that must never reach ffmpeg.
    for (const [params, expected] of [
      [{ images: [] }, /needs at least one entry in `images`/],
      [{ images: [{}] }, /images\[0\] has no `path`/],
      [{ images: [{ path: "logo.png", position: "somewhere" }] }, /position must be one of/],
      [{ images: [{ path: "logo.png", opacity: 5 }] }, /between 0 and 1/],
      [{ images: [{ path: "logo.png", widthPercent: 0 }] }, /between 1 and 100/],
      [{ images: [{ path: "logo.png", fromSeconds: 3, toSeconds: 1 }] }, /toSeconds \(1\) must be after fromSeconds \(3\)/],
      [{ images: ["gone.png"] }, /images\[0\] not found/],
      // A sound file where art was meant: ffmpeg would fail deep in the graph on
      // `[1:v]`, which tells the model nothing about which argument was wrong.
      [{ images: ["tone.mp3"] }, /is not an image or video/],
    ] as [Record<string, unknown>, RegExp][]) {
      assert.match(
        await callCompose(cwd, { operation: "overlay_image", input: "in.mp4", output: "x.mp4", ...params }),
        expected,
      );
    }
  } finally {
    cleanup();
  }
});

test("burn_subtitles times cues from the file and wraps them to fit", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, async () => {
  const { cwd, cleanup } = scratch();
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd });
  try {
    ff(["-f", "lavfi", "-i", "color=c=black:size=640x360:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=300:duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "in.mp4"]);

    // A real-world SRT: markup we can't render, punctuation that is filtergraph syntax,
    // and a line far longer than a frame is wide.
    writeFileSync(join(cwd, "subs.srt"), [
      "1", "00:00:00,500 --> 00:00:01,500", "First line, it's 50% off — <i>italic</i>{\\an8}", "",
      "2", "00:00:02,000 --> 00:00:03,000",
      "A second cue that is a great deal longer than forty-two characters and has to wrap", "",
    ].join("\n"));

    const out = await callCompose(cwd, { operation: "burn_subtitles", input: "in.mp4", subtitles: "subs.srt", output: "subbed.mp4" });
    assert.match(out, /Burned 2 subtitle cue/);
    assert.match(out, /wrapped at 42 characters/);
    assert.match(out, /last cue ends at 3\.00s/);

    // The claim is the timing: lit during a cue, dark in the gap between them.
    assert.ok(peakAt(cwd, "subbed.mp4", 1.0, 250, 300, 140) > 100, "the first cue should be on screen at 1s");
    assert.equal(peakAt(cwd, "subbed.mp4", 1.8, 250, 300, 140), 0, "and gone in the gap");
    assert.ok(peakAt(cwd, "subbed.mp4", 2.5, 250, 280, 160) > 100, "the second cue should be on screen at 2.5s");
    assert.equal(peakAt(cwd, "subbed.mp4", 3.6, 250, 280, 160), 0, "and gone after the last cue");
    assert.match(await callCompose(cwd, { operation: "probe", input: "subbed.mp4" }), /audio: yes/);

    // Style applies to every cue, and is validated exactly as an overlay_text cue is.
    assert.match(
      await callCompose(cwd, {
        operation: "burn_subtitles", input: "in.mp4", subtitles: "subs.srt", output: "styled.mp4",
        style: { position: "top", color: "#ffcc00", box: false, fontSize: 20 }, maxCharsPerLine: 20,
      }),
      /wrapped at 20 characters/,
    );
    assert.ok(peakAt(cwd, "styled.mp4", 1.0, 250, 20, 140) > 100, "style.position moves every cue");

    // Cues past the end of the video are a real authoring mistake — a VO that was cut —
    // and silently dropping them is how it stays unnoticed.
    writeFileSync(join(cwd, "long.srt"), ["1", "00:00:09,000 --> 00:00:10,000", "never seen", ""].join("\n"));
    assert.match(
      await callCompose(cwd, { operation: "burn_subtitles", input: "in.mp4", subtitles: "long.srt", output: "l.mp4" }),
      /run 6\.\d\ds past the end of the video/,
    );

    for (const [params, expected] of [
      [{}, /needs `subtitles`/],
      [{ subtitles: "in.mp4" }, /no cues found/],
      [{ subtitles: "subs.srt", maxCharsPerLine: 1 }, /between 10 and 200/],
      [{ subtitles: "subs.srt", style: { color: "white@0.2" } }, /colour name/],
      [{ subtitles: "subs.srt", style: { position: "diagonal" } }, /position must be one of/],
      [{ subtitles: "gone.srt" }, /subtitles not found/],
    ] as [Record<string, unknown>, RegExp][]) {
      assert.match(
        await callCompose(cwd, { operation: "burn_subtitles", input: "in.mp4", output: "x.mp4", ...params }),
        expected,
      );
    }
  } finally {
    cleanup();
  }
});

// The subtitle parser, on its own — no ffmpeg, no files. It has to survive both formats
// and the debris a hand-edited file collects, because the alternative to parsing it here
// is ffmpeg's libass, which not every install has.
test("parseSubtitleCues reads SubRip and WebVTT, and skips what isn't a cue", () => {
  const cues = parseSubtitleCues([
    "WEBVTT", "", "NOTE a comment nobody should see", "",
    "00:01.000 --> 00:02.500 align:start line:90%", "Vtt cue <c.yellow>styled</c>", "",
    "42", "00:00:03,000 --> 00:00:04,000", "Srt cue", "with two lines", "",
    "not a timestamp --> nor this", "ignored", "",
    "00:00:06,000 --> 00:00:05,000", "backwards, dropped", "",
    "00:00:07,000 --> 00:00:08,000", "{\\an8}override stripped", "",
    "01:00:00,000 --> 01:00:01,000", "an hour in", "",
  ].join("\n"));
  assert.deepEqual(cues, [
    { from: 1, to: 2.5, text: "Vtt cue styled" },
    { from: 3, to: 4, text: "Srt cue\nwith two lines" },
    { from: 7, to: 8, text: "override stripped" },
    { from: 3600, to: 3601, text: "an hour in" },
  ]);
  // Windows line endings and a BOM are what a subtitle file downloaded from anywhere has.
  assert.deepEqual(parseSubtitleCues("﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nCRLF\r\n\r\n"), [
    { from: 1, to: 2, text: "CRLF" },
  ]);
  assert.deepEqual(parseSubtitleCues("nothing here at all"), []);
});

test("wrapLines breaks over-long lines and keeps authored ones", () => {
  assert.equal(wrapLines("one two three four five six seven eight nine ten", 20), "one two three four\nfive six seven eight\nnine ten");
  assert.equal(wrapLines("kept\nbreaks", 100), "kept\nbreaks", "a subtitler who split a line meant it");
  // A single word longer than the limit has nowhere to break, and must not be dropped.
  assert.equal(wrapLines("Llanfairpwllgwyngyll", 8), "Llanfairpwllgwyngyll");
});
