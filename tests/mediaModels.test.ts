// /image-model and /video-model: where the choice lives (config.json's `media`, every
// other key preserved), the precedence the tools apply (call's own model → this
// machine's choice → account default), the command's set/reset/picker flows against a
// stubbed catalog, and the spend quote refusing to price a model the report didn't describe.
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-media-models-test";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { effectiveMediaModel, mediaModelPref, setMediaModelPref } from "../src/config/mediaModels.ts";
import { describeCatalogRow, formatDurations, runMediaModelCommand, type CatalogModel } from "../src/tools/mediaModelCommands.ts";
import { quoteMediaCallUsd } from "../src/tools/media.ts";
import { configPath } from "../src/config/paths.ts";

const HOME = process.env.PRIVATEER_HOME!;
function reset(config?: unknown): void {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  if (config !== undefined) writeFileSync(configPath(), JSON.stringify(config, null, 2));
}
const readCfg = () => JSON.parse(readFileSync(configPath(), "utf8"));

const IMAGES: CatalogModel[] = [
  { id: "google/gemini-3.1-flash-image", name: "Nano Banana", isZdr: true },
  { id: "black-forest-labs/flux-2-pro", name: "FLUX.2 Pro", isZdr: false },
];
const VIDEOS: CatalogModel[] = [
  { id: "google/veo-3.1-lite", name: "Veo 3.1 Lite", isZdr: true, supportedDurations: [4, 6, 8], supportsImageToVideo: true, generateAudio: true },
];
const okCatalog = async (kind: "image" | "video") => ({ ok: true as const, models: kind === "image" ? IMAGES : VIDEOS });
const downCatalog = async () => ({ ok: false as const, message: "offline" });

function fakeUi(pick?: (opts: string[]) => string | undefined) {
  const notes: { msg: string; level?: string }[] = [];
  let options: string[] = [];
  return {
    notes,
    get options() { return options; },
    ui: {
      notify: (msg: string, level?: string) => notes.push({ msg, level }),
      select: pick ? async (_t: string, o: string[]) => { options = o; return pick(o); } : undefined,
    },
  };
}

test("no config means no choice — and a malformed file is not a crash", () => {
  reset();
  assert.equal(mediaModelPref("image"), undefined);
  writeFileSync(configPath(), "{ nope");
  assert.equal(mediaModelPref("video"), undefined);
});

test("set/clear writes media.* and preserves every other key", () => {
  reset({ coauthor: false, privacy: { piiAllow: ["@acme.com"] } });
  setMediaModelPref("image", "google/gemini-3.1-flash-image");
  setMediaModelPref("video", "google/veo-3.1-lite");
  assert.deepEqual(readCfg(), {
    coauthor: false,
    privacy: { piiAllow: ["@acme.com"] },
    media: { imageModel: "google/gemini-3.1-flash-image", videoModel: "google/veo-3.1-lite" },
  });
  setMediaModelPref("image", null);
  setMediaModelPref("video", null);
  assert.deepEqual(readCfg(), { coauthor: false, privacy: { piiAllow: ["@acme.com"] } }, "an empty media block is dropped");
});

test("precedence: the call's own model, then this machine's, then none (account default)", () => {
  reset();
  assert.equal(effectiveMediaModel("video", undefined), undefined);
  setMediaModelPref("video", "google/veo-3.1-lite");
  assert.equal(effectiveMediaModel("video", undefined), "google/veo-3.1-lite");
  assert.equal(effectiveMediaModel("video", ""), "google/veo-3.1-lite", "an empty string is not a choice");
  assert.equal(effectiveMediaModel("video", "bytedance/seedance-2.0"), "bytedance/seedance-2.0");
  assert.equal(effectiveMediaModel("image", undefined), undefined, "kinds don't bleed into each other");
});

test("/image-model <id> sets a catalog id; an unknown id is refused with suggestions", async () => {
  reset();
  const f = fakeUi();
  await runMediaModelCommand("image", "black-forest-labs/flux-2-pro", f.ui, okCatalog);
  assert.equal(mediaModelPref("image"), "black-forest-labs/flux-2-pro");
  assert.match(f.notes[0].msg, /non-ZDR/, "a non-ZDR pick says what it means for a ZDR account");

  await runMediaModelCommand("image", "flux", f.ui, okCatalog);
  assert.equal(mediaModelPref("image"), "black-forest-labs/flux-2-pro", "a typo never overwrites a good choice");
  assert.equal(f.notes[1].level, "warning");
  assert.match(f.notes[1].msg, /Did you mean: black-forest-labs\/flux-2-pro/);
});

test("/video-model <id> is saved with a warning when the catalog is unreachable", async () => {
  reset();
  const f = fakeUi();
  await runMediaModelCommand("video", "google/veo-3.1-lite", f.ui, downCatalog);
  assert.equal(mediaModelPref("video"), "google/veo-3.1-lite");
  assert.match(f.notes[0].msg, /couldn't check/);
});

test("/image-model default clears it without touching the network", async () => {
  reset();
  setMediaModelPref("image", "google/gemini-3.1-flash-image");
  const f = fakeUi();
  await runMediaModelCommand("image", "default", f.ui, () => { throw new Error("must not fetch"); });
  assert.equal(mediaModelPref("image"), undefined);
  assert.match(f.notes[0].msg, /account default \(was google\/gemini-3.1-flash-image\)/);
});

test("the picker: marks the current row, sets the picked one, and 'Account default' clears", async () => {
  reset();
  setMediaModelPref("video", "google/veo-3.1-lite");
  const f = fakeUi((o) => o[0]);
  await runMediaModelCommand("video", "", f.ui, okCatalog);
  assert.match(f.options[1], /^● .*google\/veo-3\.1-lite.*4\/6\/8s.*first frame.*audio/);
  assert.equal(mediaModelPref("video"), undefined, "row 0 is the account default");

  const g = fakeUi((o) => o.find((r) => r.includes("flux-2-pro")));
  await runMediaModelCommand("image", "", g.ui, okCatalog);
  assert.equal(mediaModelPref("image"), "black-forest-labs/flux-2-pro");

  const cancel = fakeUi(() => undefined);
  await runMediaModelCommand("image", "", cancel.ui, okCatalog);
  assert.equal(mediaModelPref("image"), "black-forest-labs/flux-2-pro", "cancel changes nothing");
});

test("durations collapse to a range only when contiguous", () => {
  assert.equal(formatDurations([3, 4, 5, 6, 7, 8]), "3-8s");
  assert.equal(formatDurations([5, 10]), "5/10s");
  assert.equal(formatDurations([4, 6, 8]), "4/6/8s");
});

test("describeCatalogRow names the privacy posture", () => {
  assert.match(describeCatalogRow({ id: "a/b", isTee: true }, "image"), /confidential/);
  assert.match(describeCatalogRow({ id: "a/b", isZdr: true }, "image"), /\(ZDR\)/);
  assert.match(describeCatalogRow({ id: "a/b" }, "image"), /non-ZDR/);
});

test("quote: an image model is priced only when the report describes that same model", () => {
  const caps = { image: { model: "img/chosen", maxPerCall: 4, priceUsdEach: 0.04 } };
  assert.equal(quoteMediaCallUsd("generate_image", { model: "img/chosen", count: 2 }, caps), 0.08);
  assert.equal(quoteMediaCallUsd("generate_image", { model: "img/other" }, caps), null);
});
