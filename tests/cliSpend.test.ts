import { test } from "node:test";
import assert from "node:assert/strict";
import { CLI_SPEND_ENV, CliSpendLedger, headlessSpendGuidance, readCliSpendGrant } from "../src/permissions/cliSpend.ts";
import { decideToolCall, type GateController } from "../src/ext/permissionGate.ts";

test("the grant is read defensively: no cap, no billed tool, or junk reads as no grant", () => {
  const env = (v: unknown) => ({ [CLI_SPEND_ENV]: typeof v === "string" ? v : JSON.stringify(v) });
  assert.deepEqual(readCliSpendGrant(env({ tools: ["generate_video"], maxCalls: 1 })), { tools: ["generate_video"], maxCalls: 1 });
  assert.equal(readCliSpendGrant(env({ tools: ["generate_video"] })), null, "uncapped is not a CLI grant");
  assert.equal(readCliSpendGrant(env({ tools: ["bash"], maxCalls: 1 })), null, "only billing tools");
  assert.equal(readCliSpendGrant(env("{nope")), null);
  assert.equal(readCliSpendGrant({}), null);
});

test("--max-calls counts every allowed call and then refuses", async () => {
  const ledger = new CliSpendLedger({ tools: ["generate_video"], maxCalls: 1 }, async () => 0.5);
  assert.deepEqual(await ledger.authorize("generate_video", {}), { ok: true, usd: null });
  const second = await ledger.authorize("generate_video", {});
  assert.equal(second.ok, false);
  assert.match((second as { reason: string }).reason, /--max-calls 1 is used up/);
  const other = await ledger.authorize("generate_image", {});
  assert.match((other as { reason: string }).reason, /covers generate_video, not generate_image/);
});

test("--max-spend prices each call first, refuses what doesn't fit, and refuses what it can't price", async () => {
  const prices: Record<string, number | null> = { generate_video: 0.7, generate_music: null };
  const ledger = new CliSpendLedger(
    { tools: ["generate_video", "generate_music"], maxSpendUsd: 1.0 },
    async (tool) => prices[tool] ?? null,
  );
  assert.deepEqual(await ledger.authorize("generate_video", {}), { ok: true, usd: 0.7 });
  const over = await ledger.authorize("generate_video", {});
  assert.match((over as { reason: string }).reason, /estimated at \$0\.70 and only \$0\.30/);
  const unpriced = await ledger.authorize("generate_music", {});
  assert.match((unpriced as { reason: string }).reason, /can't be priced/);
  assert.match(ledger.summary(), /1 billed call\(s\), ~\$0\.70 of \$1\.00/);
});

test("parallel calls can't both squeeze under the same budget", async () => {
  const ledger = new CliSpendLedger({ tools: ["generate_video"], maxSpendUsd: 1.0 }, async () => 0.6);
  const [a, b] = await Promise.all([ledger.authorize("generate_video", {}), ledger.authorize("generate_video", {})]);
  assert.equal([a, b].filter((d) => d.ok).length, 1);
});

// Through the real gate: a headless (bypass) session with a grant runs the call; one
// without is denied WITH the reason and the way out, which is what the model reads.
function headlessGate(pre: GateController["isSpendPreauthorized"], notes: WeakMap<object, string>): GateController {
  return {
    getMode: () => "bypass",
    setMode: () => {},
    allowlist: [],
    allowedOutsideRoots: [],
    cwd: "/work",
    localAsk: async (req) => {
      if (!notes.has(req)) notes.set(req, headlessSpendGuidance(req.tool, "privateer"));
      return "deny";
    },
    isSpendPreauthorized: pre,
    explainDenial: (req) => notes.get(req),
  };
}

test("the gate runs a pre-approved billed call and explains a refused one", async () => {
  const notes = new WeakMap<object, string>();
  const ledger = new CliSpendLedger({ tools: ["generate_video"], maxCalls: 1 }, async () => 0.5);
  let seenInput: unknown;
  const ctrl = headlessGate(async (req, input) => {
    seenInput = input;
    const d = await ledger.authorize(req.tool, input);
    if (!d.ok) notes.set(req, `Not covered by this run's spend pre-approval: ${d.reason}.`);
    return d.ok;
  }, notes);
  const input = { prompt: "a ship", path: "clip.mp4", seconds: 6 };
  assert.equal(await decideToolCall(ctrl, "generate_video", input, {}), undefined, "first call runs");
  assert.deepEqual(seenInput, input, "the ledger prices the call's own arguments");
  const second = await decideToolCall(ctrl, "generate_video", input, {});
  assert.match(second!.reason, /--max-calls 1 is used up/);

  const bare = await decideToolCall(headlessGate(async () => false, new WeakMap()), "generate_video", input, {});
  assert.match(bare!.reason, /--allow-spend generate_video --max-calls 1/);
  assert.match(bare!.reason, /--approve-in-app/);
  assert.match(bare!.reason, /privateer acp/);
});

test("a grant never covers a billed call that writes outside the working directory", async () => {
  let asked = false;
  const ctrl = headlessGate(async () => ((asked = true), true), new WeakMap());
  const r = await decideToolCall(ctrl, "generate_video", { prompt: "x", path: "/etc/clip.mp4" }, {});
  assert.ok(r?.block);
  assert.equal(asked, false, "the budget isn't even consulted — nothing is spent on a refused call");
});
