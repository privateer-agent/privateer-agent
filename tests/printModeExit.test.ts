import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDep } from "../bin/apply-patches.mjs";

// Regression: `privateer -p "…"` printed the answer and then hung forever.
//
// Stock Pi's print mode sets process.exitCode and returns, trusting the event loop to
// drain. One ref'd resource anywhere in the process pins it open, and the run looks
// stuck long after the work is done. Measured: with no extensions loaded a one-shot run
// exits; with the moat it does not, and bisecting puts it on privateer-gate. What the
// gate retains is invisible to JS — process._getActiveHandles() and
// getActiveResourcesInfo() are both empty while the process sits there — so it is
// native, and nothing in JS can close it. User packages leak too (context-mode spawns
// MCP stdio servers), and those we do not control at all. Hence the fix is at the exit
// itself: patches/@earendil-works+pi-coding-agent+*.patch makes one-shot modes flush
// stdio and exit.
//
// The leak here is a bare setInterval rather than a native handle: the mechanism under
// test is "a one-shot run exits even when the loop would not drain", and an interval
// reproduces exactly that condition without needing the clipboard addon.

const CLI = resolveDep(path.resolve(import.meta.dirname, ".."), "@earendil-works/pi-coding-agent", "dist", "cli.js");

/** Build a throwaway project + agent dir, and a mock model server + provider. */
function scratch(): { root: string; agentDir: string; proj: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pv-printexit-")));
  const agentDir = path.join(root, "agent");
  const proj = path.join(root, "proj");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  return { root, agentDir, proj };
}

/** An extension that leaks a ref'd handle, exactly as a real one can. */
function writeLeakyExtension(dir: string): string {
  const file = path.join(dir, "leaky.ts");
  fs.writeFileSync(
    file,
    `export default function (pi: any) {\n` +
      `  // Never cleared, never unref'd — the event loop can no longer drain.\n` +
      `  setInterval(() => {}, 60_000);\n` +
      `}\n`,
  );
  return file;
}

/** A mock OpenAI-compatible provider pointed at `port`. */
function writeMockProvider(dir: string, port: number): string {
  const file = path.join(dir, "provider.ts");
  fs.writeFileSync(
    file,
    `export default function (pi: any) {\n` +
      `  pi.registerProvider("mock", {\n` +
      `    name: "Mock", baseUrl: "http://127.0.0.1:${port}/v1", apiKey: "mock-key", api: "openai-completions",\n` +
      `    models: [{ id: "mock-1", name: "Mock 1", reasoning: false, input: ["text"],\n` +
      `      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],\n` +
      `  });\n` +
      `}\n`,
  );
  return file;
}

/** Minimal streaming chat-completions server that always answers "mock-ok". */
async function startMockModel(): Promise<{ port: number; close: () => Promise<void> }> {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const done = { id: "1", object: "chat.completion.chunk", created: 0, model: "mock-1" };
      if (!/"stream"\s*:\s*true/.test(body)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...done, object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "mock-ok" }, finish_reason: "stop" }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ ...done, choices: [{ index: 0, delta: { role: "assistant", content: "mock-ok" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...done, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Run the CLI in print mode; resolves with its output, or rejects if it outlives `timeoutMs`. */
function runPrint(opts: { cli: string; cwd: string; agentDir: string; extensions: string[]; timeoutMs: number }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve, reject) => {
    const started = Date.now();
    const args = ["-p", "say ok", "--model", "mock/mock-1", "--no-session"];
    for (const e of opts.extensions) args.push("-e", e);
    const child = spawn(process.execPath, [opts.cli, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: opts.agentDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`print mode did not exit within ${opts.timeoutMs}ms (stdout: ${stdout.trim()})`));
    }, opts.timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

test("print mode exits even when an extension leaks a ref'd handle", async (t) => {
  assert.ok(CLI && fs.existsSync(CLI), "pi-coding-agent cli.js must be installed");
  const { root, agentDir, proj } = scratch();
  const model = await startMockModel();
  t.after(async () => {
    await model.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const provider = writeMockProvider(root, model.port);
  const leaky = writeLeakyExtension(root);

  const result = await runPrint({ cli: CLI!, cwd: proj, agentDir, extensions: [provider, leaky], timeoutMs: 60_000 });
  assert.equal(result.code, 0, `expected a clean exit, got ${result.code} (stderr: ${result.stderr})`);
  assert.match(result.stdout, /mock-ok/, "the answer must still be printed in full");
});

test("print mode preserves a failing exit code", async (t) => {
  const { root, agentDir, proj } = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // No mock server listening on this port: the turn fails, and that must surface as a
  // non-zero exit rather than being swallowed by the forced exit.
  const provider = writeMockProvider(root, 1);
  const leaky = writeLeakyExtension(root);

  const result = await runPrint({ cli: CLI!, cwd: proj, agentDir, extensions: [provider, leaky], timeoutMs: 60_000 });
  assert.equal(result.code, 1, "a failed run must still exit 1");
});
