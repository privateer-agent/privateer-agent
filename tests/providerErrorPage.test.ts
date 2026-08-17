import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDep } from "../bin/apply-patches.mjs";

// Regression: a turn died on a WAF block page, and the agent kept retrying it.
//
// The account channel's edge answered one turn with 403 and an HTML block page whose
// three inline base64 web fonts made it 221 KB. The provider SDK folds a non-JSON body
// straight into `error.message`, so that page became the turn's `errorMessage`, and
// three separate things then went wrong with it:
//
//   1. Pi printed the whole page into the terminal.
//   2. Pi appended it to the session file once per attempt — a 1.8 MB session.
//   3. Pi's transient-error classifier is a regex over the message text, and a
//      megabyte of base64 reliably contains "429", "500" and "502" — so a permanent
//      403 was judged retryable and burned the full retry budget, twice, before the
//      user ever saw what had happened.
//
// The fix is two hunks in patches/@earendil-works+pi-coding-agent+*.patch (mirrored
// and unit-tested as compactProviderError / isHardHttpFailure in src/engine/errors.ts):
// squeeze the page before anything reads it, and let the STATUS decide retryability.
// This test drives the real CLI against a server that answers exactly like that edge
// did, because the bug lived in the wiring between those two hunks and Pi's event flow,
// not in either helper.

const CLI = resolveDep(path.resolve(import.meta.dirname, ".."), "@earendil-works/pi-coding-agent", "dist", "cli.js");

// A base64 run that carries the substrings which made the real page look transient.
// Not contrived: the actual 221 KB of font matched "429", "500", "502" and "503" — the
// classifier's own patterns — at four separate offsets. Any large blob eventually does.
const FONT = "d09GMk9UVE8AAKew429Ehsl500PpNH502lojeAe503OJLm".repeat(4000);

/** A WAF block page shaped like the one that caused this — fonts included. */
const BLOCK_PAGE =
  `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <title>Blocked</title>\n` +
  `    <style>@font-face { font-family: "Roobert"; src: url("data:font/woff2;base64,${FONT}"); }</style>\n` +
  `  </head>\n  <body>\n` +
  `    <h1>403 - Forbidden</h1>\n` +
  `    <p>Your request was blocked by this site&#x27;s web application firewall (WAF).</p>\n` +
  `    <p>Request ID: a2c64e100ae6d331</p>\n` +
  `  </body>\n</html>\n`;

function scratch(): { root: string; agentDir: string; proj: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pv-errpage-")));
  const agentDir = path.join(root, "agent");
  const proj = path.join(root, "proj");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  return { root, agentDir, proj };
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

/** A server that answers every request the way a WAF does: 403 and a page. */
async function startBlockingEdge(): Promise<{ port: number; requests: () => number; close: () => Promise<void> }> {
  const http = await import("node:http");
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
      res.end(BLOCK_PAGE);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    requests: () => requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function runPrint(opts: { cwd: string; agentDir: string; extensions: string[]; timeoutMs: number }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const args = ["-p", "say ok", "--model", "mock/mock-1", "--no-session"];
    for (const e of opts.extensions) args.push("-e", e);
    const child = spawn(process.execPath, [CLI!, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, PI_CODING_AGENT_DIR: opts.agentDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the run did not finish within ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("a WAF block page is reported short, and never retried", async (t) => {
  assert.ok(CLI && fs.existsSync(CLI), "pi-coding-agent cli.js must be installed");
  const { root, agentDir, proj } = scratch();
  const edge = await startBlockingEdge();
  t.after(async () => {
    await edge.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const result = await runPrint({
    cwd: proj,
    agentDir,
    extensions: [writeMockProvider(root, edge.port)],
    timeoutMs: 60_000,
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.code, 0, "a blocked turn must fail");
  // A 403 is the request being refused, not a throttle: one attempt, no backoff.
  assert.equal(edge.requests(), 1, `expected one attempt, the edge saw ${edge.requests()}`);
  // What the user reads: the status, the page's own words, and the id to quote at
  // whoever owns the firewall — not a screenful of embedded font.
  assert.match(output, /403/);
  assert.match(output, /web application firewall/i);
  assert.match(output, /Request ID: a2c64e100ae6d331/);
  assert.doesNotMatch(output, /d09GMk9UVE8|base64/, "the embedded font must never be printed");
  assert.ok(output.length < 8_000, `expected a short report, got ${output.length} chars`);
});
