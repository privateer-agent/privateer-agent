import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelMessage, LanguageModel } from "ai";
import {
  selectRoute,
  requiredModalities,
  type Route,
  type RouteSet,
  type Modality,
} from "../src/engine/router.ts";

// selectRoute never touches Route.model, so a placeholder is fine for these tests.
function route(spec: string, supports: Modality[] = []): Route {
  return { spec, model: {} as LanguageModel, cacheControl: false, label: spec, supports: new Set(supports) };
}

function routes(over: Partial<RouteSet> = {}): RouteSet {
  return {
    default: route("default"),
    longThreshold: 1000,
    fastMaxChars: 50,
    ...over,
  };
}

const mods = (...m: Modality[]) => new Set<Modality>(m);

test("selectRoute: an image turn goes to the vision route", () => {
  const r = routes({ vision: route("vision", ["image"]), long: route("long"), fast: route("fast") });
  const sel = selectRoute(r, { modalities: mods("image"), estTokens: 99999, promptChars: 1 });
  assert.equal(sel.name, "vision");
  assert.equal(sel.reason, "image input");
  assert.ok(!sel.missing?.length);
});

test("selectRoute: capability requirement outranks long/fast", () => {
  // Long would apply by tokens and fast by length, but the image must be satisfied.
  const r = routes({ vision: route("vision", ["image"]), long: route("long"), fast: route("fast") });
  assert.equal(selectRoute(r, { modalities: mods("image"), estTokens: 99999, promptChars: 1 }).name, "vision");
});

test("selectRoute: a multi-modality turn picks a route covering the union", () => {
  // vision covers only image; document covers image+document → it must win.
  const r = routes({
    vision: route("vision", ["image"]),
    document: route("document", ["image", "document"]),
  });
  const sel = selectRoute(r, { modalities: mods("image", "document"), estTokens: 0, promptChars: 0 });
  assert.equal(sel.name, "document");
  assert.ok(!sel.missing?.length);
});

test("selectRoute: no route covers the modality → best partial + missing flagged", () => {
  const r = routes({ vision: route("vision", ["image"]) });
  const sel = selectRoute(r, { modalities: mods("audio"), estTokens: 0, promptChars: 0 });
  assert.deepEqual(sel.missing, ["audio"]);
});

test("selectRoute: long applies above the token threshold, fast for short prompts", () => {
  const r = routes({ long: route("long"), fast: route("fast") });
  assert.equal(selectRoute(r, { modalities: mods(), estTokens: 1001, promptChars: 1 }).name, "long");
  assert.equal(selectRoute(r, { modalities: mods(), estTokens: 0, promptChars: 50 }).name, "fast");
  assert.equal(selectRoute(r, { modalities: mods(), estTokens: 0, promptChars: 51 }).name, "default");
  // Long outranks fast.
  assert.equal(selectRoute(r, { modalities: mods(), estTokens: 5000, promptChars: 10 }).name, "long");
});

test("requiredModalities reads image + file parts across history (sticky)", () => {
  const plain: ModelMessage[] = [{ role: "user", content: "hello" }];
  assert.equal(requiredModalities(plain).size, 0);

  const mixed: ModelMessage[] = [
    { role: "user", content: [{ type: "image", image: "deadbeef" }] },
    { role: "assistant", content: "ok" },
    { role: "user", content: [{ type: "file", data: "x", mediaType: "application/pdf" }] },
    { role: "user", content: "later text-only turn" },
  ];
  // Union over the whole conversation → stays multimodal even on a later text turn.
  assert.deepEqual([...requiredModalities(mixed)].sort(), ["document", "image"]);

  const av: ModelMessage[] = [
    { role: "user", content: [{ type: "file", data: "x", mediaType: "audio/mpeg" }] },
    { role: "user", content: [{ type: "file", data: "y", mediaType: "video/mp4" }] },
  ];
  assert.deepEqual([...requiredModalities(av)].sort(), ["audio", "video"]);
});
