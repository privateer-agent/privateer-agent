// One pi-privacy configuration, two routes into it — and what it cost when they drifted.
//
// A session reaches pi-privacy either through src/config/moat.ts (factory-built: harbor,
// live tasks, channels, ACP, the REPL) or through extensions/privateer-privacy.ts (what Pi
// DISCOVERS for the interactive TUI, and what bin/privateer-subagent.mjs injects into every
// subagent child). Each site used to hand pi-privacy its own options object, and each was
// missing something the other had:
//
//   - the discovered copy had no `piiUnattended`, so in the terminal — the only place
//     shift+tab exists — no quarter lowered our moat and pi-privacy still stopped the turn
//     to ask "PII detected: send as-is or redact?";
//   - the factory-built copy had no `resolveTier`, so it judged the private ACCOUNT
//     channel by pi-privacy's PUBLIC developer-key entry (floor: zdr-policy). The badge
//     under-reported the channel, and the PII gate treated an attested TEE session as
//     unverified and asked about PII on every turn — the exact over-warning c2ee0fa fixed
//     for the terminal and nowhere else.
//
// Both now take src/config/privacyPolicy.ts whole, so every test here runs against BOTH
// routes: a fix that only holds on the route that didn't have the bug is not a fix.
process.env.PRIVATEER_HOME = "/private/tmp/claude-501/pv-privacy-policy-test";
process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";
process.env.PI_SUBAGENT_CHILD = "1"; // skip the gate's parent approval relay (a live timer)
process.env.PRIVATEER_SEALED = "0"; // keep accountPosture off the network — see ACCOUNT_TEE_MODEL

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import privateerPrivacy from "../extensions/privateer-privacy.ts";
import { privacyExtension } from "../src/config/privacyPolicy.ts";
import { buildMoat, type ExtensionFactory } from "../src/config/moat.ts";
import { setNoQuarter } from "../src/permissions/noQuarter.ts";
import { addPiiAllow, removePiiAllow } from "../src/config/piiAllow.ts";
import type { GateController } from "../src/ext/permissionGate.ts";

rmSync(process.env.PRIVATEER_HOME!, { recursive: true, force: true });

// A domain the default allowlist does NOT cover — example.com and friends are suppressed
// by design (see pi-privacy's DEFAULT_ALLOW), so a test written with one would pass for
// the wrong reason.
const EMAIL = "jane.doe@acme-corp.io";

// An account-channel TEE model whose posture is decided WITHOUT any I/O: `phala/` is a
// TEE prefix, and with sealed mode off accountPosture returns tee-unverified outright
// ("confidential compute, unconfirmed" — we can't bind a quote to a proxied connection).
// That makes it the discriminator this suite needs: pi-privacy on its own would floor the
// same model to zdr-policy, so the two answers are distinguishable and neither is faked.
const ACCOUNT_TEE_MODEL = "phala/qwen3-coder";
const ACCOUNT_TIER_BADGE = /TEE \(unconfirmed\)/;
const PI_PRIVACY_FLOOR_BADGE = /ZDR \(by policy\)/;

interface Session {
  selects: string[];
  notices: string[];
  badges: string[];
  selectModel: (provider: string, id: string) => Promise<void>;
  request: (payload: unknown) => Promise<any>;
}

// Apply extension factories to a fake Pi, capture what registers for the events this suite
// drives, and return a driver for one session with a UI fully able to prompt. Anything a
// factory needs beyond this is a no-op; a factory that can't cope is skipped, since only
// pi-privacy's handlers are at issue.
function session(factories: ExtensionFactory[]): Session {
  const onRequest: ((event: any, ctx: any) => Promise<any>)[] = [];
  const onModelSelect: ((event: any, ctx: any) => any)[] = [];
  const selects: string[] = [];
  const notices: string[] = [];
  const badges: string[] = [];
  const pi: any = {
    on: (event: string, fn: any) => {
      if (event === "before_provider_request") onRequest.push(fn);
      if (event === "model_select") onModelSelect.push(fn);
    },
    registerProvider: () => {},
    registerCommand: () => {},
    registerTool: () => {},
    setModel: () => true,
    getModel: () => undefined,
  };
  for (const f of factories) {
    try {
      f(pi);
    } catch {
      // Not the extension under test — its own suite covers it.
    }
  }
  assert.ok(onRequest.length > 0, "pi-privacy registered no before_provider_request handler");
  assert.ok(onModelSelect.length > 0, "pi-privacy registered no model_select handler");

  const ctx = {
    hasUI: true,
    ui: {
      // The prompt under test. Recording it (rather than answering) is the assertion:
      // under no quarter this must never be reached.
      select: async (title: string, options: string[]) => {
        selects.push(title);
        return options[0];
      },
      notify: (msg: string) => notices.push(msg),
      // The posture badge's first sink. `pi-privacy` is pi-privacy's own badge key; the
      // filter keeps another extension's status line out of the assertion.
      setStatus: (key: string, value: string) => {
        if (key === "pi-privacy" && value) badges.push(value);
      },
    },
  };

  return {
    selects,
    notices,
    badges,
    // model_select fires attestation as a floating promise (`void refreshPosture()`), so
    // settle the microtask queue until a real tier lands rather than guessing at a delay.
    // Bounded, so a resolver that never answers fails loudly instead of hanging.
    selectModel: async (provider: string, id: string) => {
      for (const h of onModelSelect) await h({ model: { provider, id } }, ctx);
      for (let i = 0; i < 200 && !badges.some((b) => !b.includes("checking")); i++) {
        await new Promise((r) => setImmediate(r));
      }
    },
    request: async (payload: unknown) => {
      let current = payload;
      for (const h of onRequest) current = (await h({ payload: current }, ctx)) ?? current;
      return current;
    },
  };
}

const payloadWithPii = () => ({ messages: [{ role: "user", content: `mail ${EMAIL} about the invoice` }] });

const payloadText = (payload: any): string => JSON.stringify(payload?.messages ?? payload ?? "");

// A gate controller shaped like the headless ones — buildMoat needs one, this suite never
// exercises it.
function stubGate(): GateController {
  return {
    getMode: () => "default",
    setMode: () => {},
    allowlist: [],
    allowedOutsideRoots: [],
    cwd: resolve(import.meta.dirname, ".."),
    confineToCwd: true,
    async localAsk() {
      return "deny";
    },
  } as GateController;
}

// `repl` is the cheapest moat kind — no MCP adapter, no web tools.
const moatFactories = () => buildMoat({ kind: "repl", gate: stubGate() });

// ── the account channel's tier ───────────────────────────────────────────────────────

for (const [route, factories] of [
  ["discovered extension", async () => [privateerPrivacy]],
  ["moat-built session", moatFactories],
] as [string, () => Promise<ExtensionFactory[]>][]) {
  test(`${route}: the account channel is judged by OUR posture, not pi-privacy's public-key floor`, async () => {
    const s = session(await factories());
    await s.selectModel("privateer", ACCOUNT_TEE_MODEL);

    const badge = s.badges.at(-1) ?? "";
    assert.match(badge, ACCOUNT_TIER_BADGE, `expected the account channel's own tier, got: ${badge}`);
    assert.doesNotMatch(
      badge,
      PI_PRIVACY_FLOOR_BADGE,
      "pi-privacy only knows the PUBLIC developer key — falling back to its floor mislabels the channel",
    );
  });
}

// ── no quarter vs. the PII gate ──────────────────────────────────────────────────────

for (const [route, factories] of [
  ["discovered extension", async () => [privateerPrivacy]],
  ["moat-built session", moatFactories],
] as [string, () => Promise<ExtensionFactory[]>][]) {
  test(`${route}: no quarter answers the PII gate instead of asking`, async () => {
    setNoQuarter(true);
    try {
      const s = session(await factories());
      const out = await s.request(payloadWithPii());

      assert.deepEqual(s.selects, [], "no quarter must not raise a privacy prompt");
      assert.ok(!payloadText(out).includes(EMAIL), "the unattended answer is redact-then-send, not send-as-is");
      assert.ok(
        s.notices.some((n) => n.includes("unattended")),
        `the decision made on the operator's behalf must be reported: ${JSON.stringify(s.notices)}`,
      );
    } finally {
      setNoQuarter(false);
    }
  });
}

// The bug that reached users: no quarter was ON and the PII gate asked anyway.
//
// Pi loads each extension with its own jiti instance and `moduleCache: false`, so
// extensions/privateer-gate.ts (where shift+tab lives) and extensions/privateer-privacy.ts
// each hold their OWN copy of src/permissions/noQuarter.ts. While that module kept the
// state in a module-level `let`, the toggle only ever reached the copy the gate was
// holding — the privacy extension's copy stayed false, and a session with the moat
// visibly down still stopped the turn to ask about an email address. The state lives in
// the env now, which is the one thing every copy shares; this drives the gate's copy the
// way shift+tab does and asserts the privacy side follows.
// (the specifier is a variable so tsc doesn't try to resolve the query suffix as a path)
const GATE_COPY_SPECIFIER = "../src/permissions/noQuarter.ts?extension-copy";
const gateCopy: typeof import("../src/permissions/noQuarter.ts") = await import(GATE_COPY_SPECIFIER);

test("a toggle from the GATE extension's copy of the state reaches the privacy gate", async () => {
  assert.notEqual(gateCopy.setNoQuarter, setNoQuarter, "the copies must really be distinct");
  gateCopy.setNoQuarter(true); // shift+tab, as extensions/privateer-gate.ts applies it
  try {
    const s = session([privateerPrivacy]);
    const out = await s.request(payloadWithPii());

    assert.deepEqual(s.selects, [], "no quarter must not raise a privacy prompt, whoever flipped it");
    assert.ok(!payloadText(out).includes(EMAIL), "the unattended answer is redact-then-send, not send-as-is");
  } finally {
    gateCopy.setNoQuarter(false);
  }
});

// The operator's escape hatch, end to end. Detection is pattern-based, so some share of
// what it finds is a filename, a version quad or a fixture mailbox — and under no quarter
// nobody is asked before it is rewritten. `/privacy allow …` is the answer to that, and
// it is only an answer if it reaches pi-privacy from the config file AND applies to the
// session already running: "restart to stop masking your own asset filenames" is not one.
test("an allowlisted value is not PII — and the entry applies mid-session", async () => {
  mkdirSync(process.env.PRIVATEER_HOME!, { recursive: true });
  setNoQuarter(true); // auto-redact, so the gate's answer is observable without a prompt
  try {
    const s = session([privateerPrivacy]);

    const before = await s.request(payloadWithPii());
    assert.ok(!payloadText(before).includes(EMAIL), "not allowlisted yet — masked before send");
    assert.equal(s.notices.length, 1);

    addPiiAllow("@acme-corp.io"); // `/privacy allow @acme-corp.io`, with the session live
    const after = await s.request(payloadWithPii());
    assert.ok(payloadText(after).includes(EMAIL), "left byte-for-byte alone, without a relaunch");
    assert.equal(s.notices.length, 1, "and nothing to report — it was never PII here");
  } finally {
    removePiiAllow("@acme-corp.io");
    setNoQuarter(false);
  }
});

// `/privacy` is the only way most people will ever touch the allowlist, so it is worth a
// test of its own: the wrong verb must not silently do nothing, and `allow` must actually
// reach the file the gate reads.
test("/privacy allow, unallow, and the bare listing", () => {
  mkdirSync(process.env.PRIVATEER_HOME!, { recursive: true });
  const commands = new Map<string, any>();
  privacyExtension()({
    on: () => {},
    registerProvider: () => {},
    registerCommand: (name: string, spec: any) => commands.set(name, spec),
    registerTool: () => {},
  } as any);

  const privacy = commands.get("privacy");
  assert.ok(privacy, "the escape hatch has to be reachable");

  const said: string[] = [];
  const ctx = { ui: { notify: (m: string) => said.push(m) } };
  const run = (args: string) => (said.length = 0, privacy.handler(args, ctx), said.join("\n"));

  assert.match(run(""), /allowlist: empty/i);
  assert.match(run("allow @acme-corp.io"), /no longer treated as PII/);
  try {
    assert.match(run(""), /@acme-corp\.io/, "and it is listed back");
    assert.match(run("allow"), /usage/, "a verb with no value explains itself");
    assert.match(run("wat"), /unknown option/, "a typo'd verb is never a silent no-op");
    assert.match(run("unallow @acme-corp.io"), /gated again/);
    assert.match(run(""), /allowlist: empty/i);
  } finally {
    removePiiAllow("@acme-corp.io");
  }
});

// The other half: with the moat up, the question is the user's to answer. Without this,
// the tests above would still pass if the gate were simply switched off.
test("with the moat up, the PII gate still asks", async () => {
  setNoQuarter(false);
  const s = session([privateerPrivacy]);
  await s.request(payloadWithPii());

  assert.equal(s.selects.length, 1, "an attended session must still be asked");
  assert.match(s.selects[0], /detected/, `unexpected prompt: ${s.selects[0]}`);
});
