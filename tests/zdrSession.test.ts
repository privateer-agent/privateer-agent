// Require-ZDR misses on the account channel: recognising both server shapes, the
// readable message that replaces the raw JSON, the session-only opt-out riding as
// `requireZdr: false`, the miss prompt's three answers, and /zdr's confirmation.
//
// The legacy fixture is the error a user actually saw on 2026-11-26.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  describeZdrMiss,
  parseZdrMiss,
  promptZdrMiss,
  resetZdrSession,
  runZdrCommand,
  withZdrOptOut,
  zdrOptedOut,
  zdrSessionSummary,
} from "../src/providers/zdrSession.ts";

const LEGACY =
  '404: {"message":"No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy","code":404,"metadata":{"routing_funnel":[{"step":"Initial Endpoints","endpoint_count":1}],"failed_routing_step":"Filter by Data Policy"}}';
const TYPED =
  '404 {"message":"qwen/xyz has no Zero Data Retention endpoint, and this account requires ZDR.","type":"invalid_request_error","code":"ZDR_NO_ENDPOINT","model":"qwen/xyz","alternatives":["qwen/qwen3.8-max","near/Qwen/Qwen3.8-27B","bad id; rm -rf"]}';

const isZdr = (id: string) => !id.startsWith("tinfoil/") && !id.startsWith("near/");

beforeEach(() => resetZdrSession());

test("parses the legacy OpenRouter body", () => {
  assert.deepEqual(parseZdrMiss(LEGACY), { model: undefined, alternatives: [] });
});

test("parses the typed body and drops anything that isn't a model id", () => {
  assert.deepEqual(parseZdrMiss(TYPED), {
    model: "qwen/xyz",
    alternatives: ["qwen/qwen3.8-max", "near/Qwen/Qwen3.8-27B"],
  });
});

test("ignores unrelated errors", () => {
  assert.equal(parseZdrMiss("404 No endpoints found for foo/bar."), null);
  assert.equal(parseZdrMiss("402 Insufficient credits"), null);
  assert.equal(parseZdrMiss(undefined), null);
});

test("the replacement keeps the 404 lead and never mentions OpenRouter", () => {
  const msg = describeZdrMiss(parseZdrMiss(LEGACY)!, "qwen/xyz", true);
  assert.match(msg, /^404 qwen\/xyz has no Zero Data Retention endpoint/);
  assert.match(msg, /\/zdr off/);
  assert.doesNotMatch(msg, /openrouter/i);
  const headless = describeZdrMiss(parseZdrMiss(TYPED)!, undefined, false);
  assert.match(headless, /ZDR models you can use: qwen\/qwen3\.8-max, near\/Qwen\/Qwen3\.8-27B/);
  assert.match(headless, /Settings → Privacy/);
  assert.doesNotMatch(headless, /\/zdr/);
});

test("no opt-out by default: the payload is untouched", () => {
  assert.equal(withZdrOptOut({ model: "qwen/xyz", messages: [] }, isZdr), undefined);
});

test("a per-model opt-out adds requireZdr:false for that model only, never for a TEE model", async () => {
  const ui = {
    select: async (_t: string, opts: string[]) => opts.find((o) => o.startsWith("Use qwen/xyz without ZDR")),
    notify: () => {},
    setStatus: () => {},
  };
  const out = await promptZdrMiss({ model: "qwen/xyz", alternatives: [] }, undefined, ui, {
    findModel: () => undefined,
    setModel: () => true,
  });
  assert.equal(out, "opted-out");
  assert.deepEqual(withZdrOptOut({ model: "qwen/xyz", stream: true }, isZdr), { model: "qwen/xyz", stream: true, requireZdr: false });
  assert.equal(withZdrOptOut({ model: "anthropic/claude-opus-5" }, isZdr), undefined);
  assert.equal(zdrOptedOut("qwen/xyz"), true);
  // It never asks again for a model already opted out.
  assert.equal(await promptZdrMiss({ model: "qwen/xyz", alternatives: [] }, undefined, ui, { findModel: () => undefined, setModel: () => true }), "skipped");
});

test("switching offers only registered alternatives, recommends the first, and saves it", async () => {
  let shown: string[] = [];
  let set: unknown;
  let saved: string | undefined;
  const ui = {
    select: async (_t: string, opts: string[]) => {
      shown = opts;
      return opts[0];
    },
    notify: () => {},
  };
  const out = await promptZdrMiss(
    { model: "qwen/xyz", alternatives: ["qwen/gone", "qwen/qwen3.8-max", "near/Qwen/Qwen3.8-27B"] },
    undefined,
    ui,
    {
      findModel: (id) => (id === "qwen/gone" ? undefined : { id }),
      setModel: (m) => {
        set = m;
        return true;
      },
      saveDefault: (ref) => {
        saved = ref;
      },
    },
  );
  assert.equal(out, "switched");
  assert.deepEqual(shown, [
    "Switch to qwen/qwen3.8-max  (recommended)",
    "Switch to near/Qwen/Qwen3.8-27B",
    "Use qwen/xyz without ZDR for this session only",
    "Cancel",
  ]);
  assert.deepEqual(set, { id: "qwen/qwen3.8-max" });
  assert.equal(saved, "privateer/qwen/qwen3.8-max");
  assert.equal(zdrOptedOut("qwen/xyz"), false);
});

test("cancel changes nothing and isn't asked again for that model", async () => {
  let asks = 0;
  const ui = {
    select: async () => {
      asks++;
      return "Cancel";
    },
    notify: () => {},
  };
  const deps = { findModel: () => undefined, setModel: () => true };
  assert.equal(await promptZdrMiss({ model: "qwen/xyz", alternatives: [] }, undefined, ui, deps), "cancelled");
  assert.equal(await promptZdrMiss({ model: "qwen/xyz", alternatives: [] }, undefined, ui, deps), "skipped");
  assert.equal(asks, 1);
  assert.equal(zdrSessionSummary(), null);
});

test("/zdr off asks first; a no leaves ZDR required", async () => {
  const notes: string[] = [];
  await runZdrCommand("off", { confirm: async () => false, notify: (m) => notes.push(m) }, {});
  assert.equal(zdrOptedOut("qwen/xyz"), false);
  await runZdrCommand("off", { confirm: async () => true, notify: (m) => notes.push(m), setStatus: () => {} }, {});
  assert.equal(zdrOptedOut("qwen/xyz"), true);
  assert.equal(zdrOptedOut("anthropic/anything"), true);
  assert.equal(zdrSessionSummary(), "all models");
});

test("/zdr off without a confirm dialog refuses rather than opting out", async () => {
  const notes: string[] = [];
  await runZdrCommand("off", { notify: (m) => notes.push(m) }, {});
  assert.equal(zdrOptedOut("qwen/xyz"), false);
  assert.match(notes[0], /interactive terminal/);
});

test("/zdr on clears every opt-out and the status line", async () => {
  let status: string | undefined = "x";
  const ui = { confirm: async () => true, notify: () => {}, setStatus: (_k: string, t: string | undefined) => (status = t) };
  await runZdrCommand("off", ui, {});
  assert.match(status ?? "", /non-ZDR this session \(all models\)/);
  await runZdrCommand("on", ui, {});
  assert.equal(status, undefined);
  assert.equal(zdrOptedOut("qwen/xyz"), false);
});
