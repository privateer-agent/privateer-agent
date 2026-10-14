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

test("--private is stripped anywhere before --, and only there", async () => {
  const { extractPrivateFlag } = await import("../bin/headless-flags.mjs");
  const a = ["-p", "--private", "summarize a.csv"];
  assert.equal(extractPrivateFlag(a), true);
  assert.deepEqual(a, ["-p", "summarize a.csv"], "Pi never sees the flag");
  const b = ["acp", "--private"];
  assert.equal(extractPrivateFlag(b), true);
  assert.deepEqual(b, ["acp"]);
  const c = ["-p", "--", "what does --private do?"];
  assert.equal(extractPrivateFlag(c), false);
  assert.deepEqual(c, ["-p", "--", "what does --private do?"]);
});

test("private mode refuses --mode json, which would stream tool results to the caller", async () => {
  const { privateProblem } = await import("../bin/headless-flags.mjs");
  assert.match(privateProblem(["--mode", "json", "x"])!, /--mode json/);
  assert.match(privateProblem(["--mode=json", "x"])!, /--mode json/);
  assert.equal(privateProblem(["-p", "x"]), null);
  assert.equal(privateProblem(["-p", "--", "--mode json"]), null);
});

// The report: agents asked to "use Privateer" ran `auth check --provider privateer` on a
// signed-in machine and got provider_not_found — Pi checks with no extensions loaded.
test("auth check for the privateer provider is answered from the account login", async () => {
  const { privateerAuthAnswer, authHelp } = await import("../bin/headless-flags.mjs");
  const ready = privateerAuthAnswer(["auth", "check", "--provider", "privateer", "--json"], true)!;
  assert.deepEqual(JSON.parse(ready.out), { status: "ready", provider: "privateer", authType: "oauth" });
  assert.equal(ready.code, 0);
  assert.equal(privateerAuthAnswer(["auth", "check", "--provider=privateer"], true)!.out, "ready");
  assert.equal(privateerAuthAnswer(["auth", "check", "--model", "privateer/glm-5.2"], true)!.code, 0);

  const out = privateerAuthAnswer(["auth", "check", "--provider", "privateer", "--json"], false)!;
  assert.equal(JSON.parse(out.out).reason, "credentials_not_configured");
  assert.equal(out.code, 1);
  assert.match(out.err, /\/login/);

  // The account token is the login itself: never printed.
  const print = privateerAuthAnswer(["auth", "print-api-key", "--provider", "privateer"], true)!;
  assert.equal(print.out, "");
  assert.match(print.err, /isn't printed/);
  const creds = privateerAuthAnswer(["auth", "check", "--provider", "privateer", "--credentials", "--json"], true)!;
  assert.equal(JSON.parse(creds.out).reason, "credential_not_available");
  assert.ok(!creds.out.includes("token"));

  // Everything else is still Pi's.
  assert.equal(privateerAuthAnswer(["auth", "check", "--provider", "openai"], true), null);
  assert.equal(privateerAuthAnswer(["auth", "check", "--model", "openai/gpt-5"], true), null);
  assert.equal(privateerAuthAnswer(["auth", "status"], true), null);
  assert.equal(privateerAuthAnswer(["hello", "check", "--provider", "privateer"], true), null);

  assert.ok(!/\bpi auth\b/.test(authHelp("privateer")), "help names our command, not Pi's");
  assert.match(authHelp("privateer"), /--provider privateer/);
});
