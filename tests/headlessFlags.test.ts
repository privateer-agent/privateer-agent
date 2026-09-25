import { test } from "node:test";
import assert from "node:assert/strict";

// The launcher's headless-run grammar (bin/headless-flags.mjs). The launcher runs on
// import, so its rules live in a module that can be tested — same reason as
// update-route.mjs.
const { extractHeadlessFlags, authProblem, isHeadlessRun, PI_SUBCOMMANDS } = await import("../bin/headless-flags.mjs");

test("--allow-spend is stripped, normalized and capped", () => {
  const args = ["-p", "--allow-spend", "video,generate_image", "--max-calls", "2", "--max-spend=$1.50", "make a clip"];
  const r = extractHeadlessFlags(args);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.spend, { tools: ["generate_video", "generate_image"], maxCalls: 2, maxSpendUsd: 1.5 });
  assert.deepEqual(args, ["-p", "make a clip"], "Pi never sees the flags");
});

test("a spend grant must be capped, named, and headless", () => {
  assert.match(extractHeadlessFlags(["-p", "--allow-spend", "video", "x"]).error!, /needs a cap/);
  assert.match(extractHeadlessFlags(["-p", "--max-calls", "1", "x"]).error!, /name the tools/);
  assert.match(extractHeadlessFlags(["--allow-spend", "video", "--max-calls", "1", "x"]).error!, /headless run/);
  assert.match(extractHeadlessFlags(["-p", "--allow-spend", "videos", "--max-calls", "1"]).error!, /not a billed tool/);
  assert.match(extractHeadlessFlags(["-p", "--allow-spend", "video", "--max-calls", "0"]).error!, /1 or more/);
  assert.match(extractHeadlessFlags(["-p", "--allow-spend", "video", "--max-spend", "free"]).error!, /dollar amount/);
  assert.match(extractHeadlessFlags(["-p", "--allow-spend"]).error!, /needs a value/);
  // --mode json is headless too.
  assert.equal(extractHeadlessFlags(["--mode", "json", "--allow-spend", "sfx", "--max-calls", "3"]).error, undefined);
});

test("flags after -- are the user's message, not ours", () => {
  const args = ["-p", "--", "explain --allow-spend video"];
  const r = extractHeadlessFlags(args);
  assert.equal(r.spend, undefined);
  assert.deepEqual(args, ["-p", "--", "explain --allow-spend video"]);
});

test("--approve-in-app: headless only, with a bounded timeout", () => {
  const args = ["-p", "--approve-in-app", "--approval-timeout", "120", "go"];
  assert.equal(extractHeadlessFlags(args).approveInAppMs, 120_000);
  assert.deepEqual(args, ["-p", "go"]);
  assert.equal(extractHeadlessFlags(["-p", "--approve-in-app"]).approveInAppMs, 300_000);
  assert.match(extractHeadlessFlags(["--approve-in-app"]).error!, /headless run/);
  assert.match(extractHeadlessFlags(["-p", "--approval-timeout", "60"]).error!, /only applies with --approve-in-app/);
  assert.match(extractHeadlessFlags(["-p", "--approve-in-app", "--approval-timeout", "5"]).error!, /10-3600/);
});

test("isHeadlessRun", () => {
  assert.equal(isHeadlessRun(["-p", "x"]), true);
  assert.equal(isHeadlessRun(["--mode", "json"]), true);
  assert.equal(isHeadlessRun(["--mode", "rpc"]), false);
  assert.equal(isHeadlessRun(["--", "-p"]), false);
});

// The report: `privateer auth status` / `auth list` were sent to the model as chat.
test("an unknown auth subcommand is an error, never a prompt", () => {
  assert.match(authProblem(["auth", "list"])!, /unknown command "list"/);
  assert.match(authProblem(["auth", "list"])!, /Nothing was sent to a model/);
  assert.equal(authProblem(["auth", "status"]), null, "status is answered by the launcher");
  assert.equal(authProblem(["auth", "check", "--provider", "openai"]), null);
  assert.equal(authProblem(["auth"]), null, "bare auth is Pi's help");
  assert.equal(authProblem(["auth", "--help"]), null);
  assert.equal(authProblem(["hello", "auth"]), null);
  for (const sub of ["auth", "install", "remove", "uninstall", "list", "config"]) assert.ok(PI_SUBCOMMANDS.includes(sub));
});
