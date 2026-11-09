#!/usr/bin/env node
// Prove an unpacked release bundle really runs: Pi from its compiled boot build, the
// shipped extensions loaded, and a tool call carried out. `--version` can't show any of
// that, because the launcher answers it before Pi loads.
//
//   <bundle>/node scripts/smoke-bundle.mjs <bundle dir>
//
// The model is a scripted local server, so this needs no account, key or network.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const app = path.resolve(process.argv[2] ?? "");
const isWin = process.platform === "win32";
const node = path.join(app, isWin ? "node.exe" : "node");
const launcher = path.join(app, "bin", "privateer-launch.mjs");
const LIMIT_MS = 180_000;

// Split in the command because every request re-sends the command text; only the
// command's output can contain it whole.
const TOOL_MARKER = "smoke-tool-ran";
const TOOL_COMMAND = 'echo smoke-tool"-ran"';
const FINAL_TEXT = "smoke-ok";
// Only a shipped extension (privateer-final-audit) can put this in a request.
const EXTENSION_MARKER = "check your work against what actually happened";

function fail(message) {
  console.error(`bundle smoke test failed: ${message}`);
  process.exit(1);
}

function chunk(delta, finishReason = null) {
  const body = { id: "smoke", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] };
  return `data: ${JSON.stringify(body)}\n\n`;
}

function replyFor(requestNumber) {
  if (requestNumber === 1) {
    const call = { index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: TOOL_COMMAND }) } };
    return chunk({ role: "assistant", tool_calls: [call] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
  }
  return chunk({ role: "assistant", content: FINAL_TEXT }) + chunk({}, "stop") + "data: [DONE]\n\n";
}

if (!fs.existsSync(node) || !fs.existsSync(launcher)) fail(`${app} is not an unpacked bundle`);

const { bootCliPath } = await import(pathToFileURL(path.join(app, "bin", "boot-bundle.mjs")).href);
if (!bootCliPath(app, {})) fail("the launcher would not use the compiled boot build");

const requests = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (data) => (body += data));
  req.on("end", () => {
    requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(replyFor(requests.length));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "privateer-smoke-"));
fs.mkdirSync(path.join(home, "agent"));
fs.writeFileSync(
  path.join(home, "agent", "models.json"),
  JSON.stringify({
    providers: {
      stub: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "stub", models: [{ id: "stub-model" }] },
    },
  }),
);

const args = [launcher, "-p", "--mode", "json", "--no-session", "--no-quarter", "--provider", "stub", "--model", "stub-model", "Run the check."];
const child = spawn(node, args, {
  cwd: home,
  env: { ...process.env, PRIVATEER_HOME: home, ...(isWin ? {} : { HOME: home }) },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (data) => (stdout += data));
child.stderr.on("data", (data) => (stderr += data));

const timer = setTimeout(() => {
  child.kill("SIGKILL");
  fail(`no exit after ${LIMIT_MS / 1000}s\n${stderr}`);
}, LIMIT_MS);
const code = await new Promise((resolve) => child.on("close", resolve));
clearTimeout(timer);
server.close();
try {
  fs.rmSync(home, { recursive: true, force: true });
} catch {
  // A runner's temp directory is not ours to worry about.
}

if (code !== 0) fail(`exit code ${code}\n${stderr}`);
if (!requests[1]?.includes(TOOL_MARKER)) fail(`the bash tool's output never reached the model\n${stderr}`);
if (!requests.some((body) => body.includes(EXTENSION_MARKER))) fail(`shipped extensions did not load\n${stderr}`);
if (!stdout.includes(FINAL_TEXT)) fail(`the final reply is missing from stdout\n${stderr}`);

console.log(`bundle smoke test passed: compiled boot build, ${requests.length} model requests`);
process.exit(0);
