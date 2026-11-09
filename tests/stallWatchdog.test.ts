import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDep } from "../bin/apply-patches.mjs";
import { StallWatchdog, replyTimeoutMs, DEFAULT_REPLY_TIMEOUT_MS } from "../src/engine/stallWatchdog.ts";

// A headless run must not wait forever on a provider that accepted the request and went
// silent (src/engine/stallWatchdog.ts). Unit-level: what arms, re-arms and disarms it.
// End to end: a real `-p` run against a mock model that sends headers and then nothing
// exits 1 with a reason, instead of hanging.

function fakeTimers() {
  const live = new Map<number, () => void>();
  let next = 1;
  return {
    timers: {
      set: ((fn: () => void) => {
        const id = next++;
        live.set(id, fn);
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      clear: ((id: number) => live.delete(id)) as unknown as typeof clearTimeout,
    },
    fireAll: () => {
      const fns = [...live.values()];
      live.clear();
      fns.forEach((f) => f());
    },
    pending: () => live.size,
  };
}

test("silence after arming fires once", () => {
  const t = fakeTimers();
  let stalls = 0;
  const w = new StallWatchdog(1000, () => stalls++, t.timers);
  w.arm();
  t.fireAll();
  assert.equal(stalls, 1);
  assert.equal(w.stalled, true);
  w.arm(); // a stalled run doesn't re-arm
  assert.equal(t.pending(), 0);
});

test("reset re-enables a stalled watchdog for the resent request", () => {
  const t = fakeTimers();
  let stalls = 0;
  const w = new StallWatchdog(1000, () => stalls++, t.timers);
  w.arm();
  t.fireAll();
  w.reset();
  assert.equal(w.stalled, false);
  w.arm();
  assert.equal(t.pending(), 1);
  t.fireAll();
  assert.equal(stalls, 2);
});

test("every streamed event restarts the clock; one timer at a time", () => {
  const t = fakeTimers();
  const w = new StallWatchdog(1000, () => assert.fail("must not fire"), t.timers);
  w.arm();
  w.arm();
  w.arm();
  assert.equal(t.pending(), 1);
  w.disarm();
  assert.equal(t.pending(), 0);
  t.fireAll();
});

test("0 turns it off", () => {
  const t = fakeTimers();
  const w = new StallWatchdog(0, () => assert.fail("must not fire"), t.timers);
  w.arm();
  assert.equal(t.pending(), 0);
});

test("PRIVATEER_REPLY_TIMEOUT is seconds; garbage falls back to the default", () => {
  assert.equal(replyTimeoutMs({}), DEFAULT_REPLY_TIMEOUT_MS);
  assert.equal(replyTimeoutMs({ PRIVATEER_REPLY_TIMEOUT: "30" }), 30_000);
  assert.equal(replyTimeoutMs({ PRIVATEER_REPLY_TIMEOUT: "0" }), 0);
  assert.equal(replyTimeoutMs({ PRIVATEER_REPLY_TIMEOUT: "soon" }), DEFAULT_REPLY_TIMEOUT_MS);
  assert.equal(replyTimeoutMs({ PRIVATEER_REPLY_TIMEOUT: "-5" }), DEFAULT_REPLY_TIMEOUT_MS);
});

const REPO = path.resolve(import.meta.dirname, "..");
const CLI = resolveDep(REPO, "@earendil-works/pi-coding-agent", "dist", "cli.js");

type Reply = (res: import("node:http").ServerResponse, attempt: number) => void;

/** Sends the stream headers and then nothing: the stall. */
const silent: Reply = (res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.flushHeaders();
};

function answers(text: string): Reply {
  return (res) => {
    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
  };
}

async function runAgainstMock(t: import("node:test").TestContext, reply: Reply, extraArgs: string[] = []) {
  assert.ok(CLI && fs.existsSync(CLI), "pi-coding-agent cli.js must be installed");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pv-stall-")));
  const home = path.join(root, "home");
  const agentDir = path.join(home, "agent");
  const proj = path.join(root, "proj");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });

  const http = await import("node:http");
  const open: import("node:http").ServerResponse[] = [];
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      bodies.push(body);
      open.push(res);
      reply(res, bodies.length);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  t.after(async () => {
    open.forEach((r) => r.destroy());
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const provider = path.join(root, "provider.ts");
  fs.writeFileSync(
    provider,
    `export default function (pi: any) {\n` +
      `  pi.registerProvider("mock", {\n` +
      `    name: "Mock", baseUrl: "http://127.0.0.1:${port}/v1", apiKey: "mock-key", api: "openai-completions",\n` +
      `    models: [{ id: "mock-1", name: "Mock 1", reasoning: false, input: ["text"],\n` +
      `      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],\n` +
      `  });\n` +
      `}\n`,
  );

  const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI!, "-p", "say ok", "--model", "mock/mock-1", "--no-session", ...extraArgs,
        "-e", provider, "-e", path.join(REPO, "extensions", "privateer-gate.ts")],
      {
        cwd: proj,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PRIVATEER_HOME: home, PRIVATEER_REPLY_TIMEOUT: "2" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => (stdout += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`still running after 60s — the watchdog never fired (stderr: ${stderr.trim()})`));
    }, 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
  return { ...result, bodies };
}

test("a -p run against a provider that stays silent tries three times, then exits 1 with a reason", async (t) => {
  const { code, stderr, bodies } = await runAgainstMock(t, silent);
  assert.equal(code, 1, `a stalled run must exit 1 (stderr: ${stderr})`);
  assert.equal(bodies.length, 3, `one attempt plus two resends (stderr: ${stderr})`);
  assert.match(stderr, /no reply from mock\/mock-1 for 2s — resending \(1 of 2\)/);
  assert.match(stderr, /no reply from mock\/mock-1 for 2s — stopped/);
});

test("a -p run that stalls once resends the request and finishes cleanly", async (t) => {
  // JSON mode, because it decides its exit code from how the last message ended.
  const { code, stderr, stdout, bodies } = await runAgainstMock(
    t,
    (res, attempt) => (attempt === 1 ? silent(res, attempt) : answers("All done.")(res, attempt)),
    ["--mode", "json"],
  );
  assert.equal(code, 0, `a recovered run must exit 0 (stderr: ${stderr})`);
  assert.equal(bodies.length, 2);
  assert.ok(bodies[1]!.includes("say ok"), "the resend must still carry the task");
  assert.match(stdout, /All done\./);
  assert.doesNotMatch(stderr, /stopped/);
});

test("a provider that answers with an error is not treated as a stall", async (t) => {
  const { code, stderr, bodies } = await runAgainstMock(t, (res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "This content was flagged." } }));
  });
  assert.equal(code, 1, `a refused run must fail (stderr: ${stderr})`);
  assert.equal(bodies.length, 1, "a refusal must not be sent again");
  assert.doesNotMatch(stderr, /resending/);
});
