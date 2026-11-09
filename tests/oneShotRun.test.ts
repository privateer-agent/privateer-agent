import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regressions found by running `privateer -p` under a benchmark harness. These drive Pi's
// real CLI and the real background-task extension against a scripted model server.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULES = path.join(HERE, "..", "node_modules");
const PI_CLI = path.join(MODULES, "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const BACKGROUND_TASKS = path.join(MODULES, "pi-background-tasks", "extensions", "background-tasks.ts");
const LAUNCHER = path.join(HERE, "..", "bin", "privateer-launch.mjs");
const FINAL_AUDIT = path.join(HERE, "..", "extensions", "privateer-final-audit.ts");
const AUDIT_MARKER = "check your work against what actually happened";
const NOTICE = "this is a one-shot run";
const NOTICE_LIMIT = 3;
const skip = process.platform === "win32" ? "needs POSIX process handling" : false;

type Reply = { status: number } | { text: string; delayMs?: number } | { tool: string; args: object };

function chunk(delta: object, finishReason: string | null = null): string {
  const body = { id: "stub", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] };
  return `data: ${JSON.stringify(body)}\n\n`;
}

function streamFor(reply: Exclude<Reply, { status: number }>): string {
  if ("tool" in reply) {
    const call = { index: 0, id: "call_1", type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } };
    return chunk({ role: "assistant", tool_calls: [call] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
  }
  return chunk({ role: "assistant", content: reply.text }) + chunk({}, "stop") + "data: [DONE]\n\n";
}

/** Serves `script` in order, then plain text forever, recording each request body. */
async function startModelServer(script: Reply[]): Promise<{ server: Server; port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (data) => (body += data));
    req.on("end", () => {
      requests.push(body);
      const reply = script[requests.length - 1] ?? { text: "Finished." };
      if ("status" in reply) {
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub refused this request" } }));
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(streamFor(reply));
      }, "delayMs" in reply ? (reply.delayMs ?? 0) : 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

function runPrint(port: number, extra: string[] = []): Promise<{ code: number | null; stderr: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privateer-oneshot-"));
  fs.writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        stub: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "stub", models: [{ id: "stub-model" }] },
      },
    }),
  );
  const args = [PI_CLI, "-p", "--mode", "json", "--no-session", "--offline", "-ne", "-ns", "-np", "-nc"];
  const child = spawn(process.execPath, [...args, "--provider", "stub", "--model", "stub-model", ...extra, "go"], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: dir },
  });
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += data));
  child.stdout.resume();
  const limit = setTimeout(() => child.kill("SIGKILL"), 60_000);
  return new Promise((resolve) => {
    child.on("close", (code) => {
      clearTimeout(limit);
      resolve({ code, stderr });
    });
  });
}

/** A one-shot run through the real launcher, with `pathDir` as the whole inherited PATH. */
function runLauncher(port: number, pathDir: string): Promise<{ code: number | null; stderr: string; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privateer-launch-"));
  fs.mkdirSync(path.join(dir, "agent"));
  fs.writeFileSync(
    path.join(dir, "agent", "models.json"),
    JSON.stringify({
      providers: {
        stub: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "stub", models: [{ id: "stub-model" }] },
      },
    }),
  );
  const args = [LAUNCHER, "-p", "--mode", "json", "--no-session", "--no-quarter", "--provider", "stub", "--model", "stub-model", "go"];
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: dir,
    env: { PATH: pathDir, HOME: dir, PRIVATEER_HOME: dir },
  });
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += data));
  child.stdout.resume();
  const limit = setTimeout(() => child.kill("SIGKILL"), 90_000);
  return new Promise((resolve) => {
    child.on("close", (code) => {
      clearTimeout(limit);
      resolve({ code, stderr, dir });
    });
  });
}

// The marker is split in the command because every request re-sends the command text; only
// the command's output can contain it whole.
const NO_NODE_MARKER = "NO_NODE_ON_PATH";
const PROBE = 'command -v node || echo NO_NODE"_ON_PATH"; "$PRIVATEER_NODE" -p "\'runtime=\'+process.version"; echo "$PATH" > foreground-path.txt';
const BACKGROUND_PROBE = { tool: "bg_run", args: { name: "path-probe", command: 'echo "$PATH" > background-path.txt', isAgent: false } };

test("the agent's shells cannot see Privateer's private runtime as a system node", { skip }, async () => {
  const noNode = fs.mkdtempSync(path.join(os.tmpdir(), "privateer-empty-path-"));
  const script: Reply[] = [{ tool: "bash", args: { command: PROBE } }, BACKGROUND_PROBE, { text: "Done.", delayMs: 1_500 }];
  const { server, port, requests } = await startModelServer(script);
  try {
    const { code, stderr, dir } = await runLauncher(port, noNode);
    assert.equal(code, 0, `exit code was ${code}; stderr: ${stderr}`);
    assert.ok(requests[1]?.includes(NO_NODE_MARKER), "`node` must not resolve in a tool shell");
    assert.match(requests[1] ?? "", /runtime=v\d+/, "$PRIVATEER_NODE must still reach the runtime on purpose");
    const runtimeDir = path.dirname(process.execPath);
    for (const file of ["foreground-path.txt", "background-path.txt"]) {
      const seen = fs.readFileSync(path.join(dir, file), "utf8").trim().split(path.delimiter);
      assert.ok(!seen.includes(runtimeDir), `${file} still lists the private runtime: ${seen.join(path.delimiter)}`);
      assert.ok(seen.includes(noNode), `${file} lost the user's own PATH: ${seen.join(path.delimiter)}`);
    }
  } finally {
    server.close();
  }
});

test("a node the user really has stays on the agent's PATH", { skip }, async () => {
  const runtimeDir = path.dirname(process.execPath);
  const { server, port, requests } = await startModelServer([{ tool: "bash", args: { command: PROBE } }]);
  try {
    const { code, stderr } = await runLauncher(port, runtimeDir);
    assert.equal(code, 0, `exit code was ${code}; stderr: ${stderr}`);
    assert.ok(!requests[1]?.includes(NO_NODE_MARKER), "the user's own node must still resolve");
  } finally {
    server.close();
  }
});

test("a one-shot run that used tools is audited once before it ends", { skip }, async () => {
  const script: Reply[] = [{ tool: "bash", args: { command: "true" } }, { text: "Done." }, { text: "Audited." }];
  const { server, port, requests } = await startModelServer(script);
  try {
    const { code, stderr } = await runPrint(port, ["-e", FINAL_AUDIT]);
    assert.equal(code, 0, `exit code was ${code}; stderr: ${stderr}`);
    assert.equal(requests.length, 3, "one extra turn, and only one");
    assert.ok(!requests[1]?.includes(AUDIT_MARKER), "the audit comes after the work");
    assert.ok(requests[2]?.includes(AUDIT_MARKER), "the last request must ask for the audit");
  } finally {
    server.close();
  }
});

test("a one-shot run that only answered is not audited", { skip }, async () => {
  const { server, port, requests } = await startModelServer([{ text: "Four." }]);
  try {
    const { code, stderr } = await runPrint(port, ["-e", FINAL_AUDIT]);
    assert.equal(code, 0, `exit code was ${code}; stderr: ${stderr}`);
    assert.equal(requests.length, 1);
  } finally {
    server.close();
  }
});

test("a one-shot run that failed is not audited", { skip }, async () => {
  const script: Reply[] = [{ tool: "bash", args: { command: "true" } }, { status: 400 }];
  const { server, port, requests } = await startModelServer(script);
  try {
    const { code, stderr } = await runPrint(port, ["-e", FINAL_AUDIT]);
    assert.equal(code, 1, `exit code was ${code}; stderr: ${stderr}`);
    assert.ok(!requests.some((body) => body.includes(AUDIT_MARKER)));
  } finally {
    server.close();
  }
});

test("JSON mode exits non-zero when the model call fails", { skip }, async () => {
  const { server, port } = await startModelServer([{ status: 400 }]);
  try {
    const { code, stderr } = await runPrint(port);
    assert.equal(code, 1, `exit code was ${code}; stderr: ${stderr}`);
    assert.match(stderr, /stub refused this request/);
  } finally {
    server.close();
  }
});

test("JSON mode exits zero when the run succeeds", { skip }, async () => {
  const { server, port } = await startModelServer([{ text: "All done." }]);
  try {
    const { code, stderr } = await runPrint(port);
    assert.equal(code, 0, `exit code was ${code}; stderr: ${stderr}`);
  } finally {
    server.close();
  }
});

test("a one-shot run warns the model before killing a running background task", { skip }, async () => {
  const start = { tool: "bg_run", args: { name: "sleeper", command: "sleep 60", isAgent: false } };
  const { server, port, requests } = await startModelServer([start, { text: "Left it running." }]);
  try {
    const { code, stderr } = await runPrint(port, ["-e", BACKGROUND_TASKS]);
    assert.equal(code, 0, `exit code was ${code}; stderr: ${stderr}`);
    assert.ok(requests[2]?.includes(NOTICE), "the model must be told before the process exits");
    assert.ok(requests[2]?.includes("sleeper"), "the notice must name the task");
    assert.equal(requests.length, 2 + NOTICE_LIMIT, "a model that keeps stopping must not loop");
  } finally {
    server.close();
  }
});

test("a one-shot run stays quiet when no background task is still running", { skip }, async () => {
  const start = { tool: "bg_run", args: { name: "quick", command: "true", isAgent: false } };
  const { server, port, requests } = await startModelServer([start, { text: "Done.", delayMs: 1_500 }]);
  try {
    const { code, stderr } = await runPrint(port, ["-e", BACKGROUND_TASKS]);
    assert.equal(code, 0, `exit code was ${code}; stderr: ${stderr}`);
    assert.ok(!requests.some((body) => body.includes(NOTICE)), "nothing was left running to warn about");
  } finally {
    server.close();
  }
});
