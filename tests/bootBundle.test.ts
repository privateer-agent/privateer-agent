import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootCliPath } from "../bin/boot-bundle.mjs";
import { isSealed } from "../bin/session-seal.mjs";
import { buildBoot, importScanText, NON_LITERAL_IMPORT } from "../scripts/build-boot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const LAUNCHER = path.join(REPO, "bin", "privateer-launch.mjs");
const skip = process.platform === "win32" ? "needs POSIX process handling" : false;

// ── which entry a launch uses ──────────────────────────────────────────────────

function fakeInstall(opts: { version?: string; manifestVersion?: string | null; git?: boolean; nested?: boolean } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "privateer-boot-entry-"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version: opts.version ?? "1.0.0" }));
  const dist = path.join(repo, "dist-boot");
  fs.mkdirSync(dist);
  for (const f of ["boot.mjs", "cli.mjs"]) fs.writeFileSync(path.join(dist, f), "");
  if (opts.manifestVersion !== null) {
    fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify({ version: opts.manifestVersion ?? "1.0.0" }));
  }
  if (opts.git) fs.mkdirSync(path.join(repo, ".git"));
  if (opts.nested !== false) {
    const pi = path.join(repo, "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(pi, { recursive: true });
    fs.writeFileSync(path.join(pi, "package.json"), "{}");
  }
  return repo;
}

test("an install with a matching build boots from it", () => {
  const repo = fakeInstall();
  assert.equal(bootCliPath(repo, {}), path.join(repo, "dist-boot", "boot.mjs"));
});

test("the opt-out always wins", () => {
  assert.equal(bootCliPath(fakeInstall(), { PRIVATEER_NO_BOOT_BUNDLE: "1" }), null);
});

test("a checkout runs its source unless asked otherwise, so edits take effect", () => {
  const repo = fakeInstall({ git: true });
  assert.equal(bootCliPath(repo, {}), null);
  assert.equal(bootCliPath(repo, { PRIVATEER_BOOT_BUNDLE: "1" }), path.join(repo, "dist-boot", "boot.mjs"));
});

test("a build from another release is ignored", () => {
  assert.equal(bootCliPath(fakeInstall({ version: "1.0.1" }), {}), null);
});

test("a missing or partial build falls back to source", () => {
  assert.equal(bootCliPath(fakeInstall({ manifestVersion: null }), {}), null);
  const repo = fakeInstall();
  fs.rmSync(path.join(repo, "dist-boot", "cli.mjs"));
  assert.equal(bootCliPath(repo, {}), null);
});

test("a hoisted install falls back to source: the build's paths assume nesting", () => {
  assert.equal(bootCliPath(fakeInstall({ nested: false }), {}), null);
});

// ── the build's guard against imports it can't see ─────────────────────────────

test("computed imports are refused, literal ones pass", () => {
  const flagged = (src: string) => NON_LITERAL_IMPORT.test(importScanText(src));
  assert.equal(flagged('await import("x")'), false);
  assert.equal(flagged("await import('x')"), false);
  assert.equal(flagged('require("x")'), false);
  assert.equal(flagged("await import(name)"), true);
  assert.equal(flagged("await import(`${PACK}/index.ts`)"), true);
  assert.equal(flagged("require(name)"), true);
  assert.equal(flagged("// await import(name)\n"), false, "comments are not code");
  assert.equal(flagged("const { parse } = require(workerData.acornPath);"), false, "a Worker's eval'd source");
});

// ── the same run, from source and from the build ──────────────────────────────

type Reply = { text: string } | { tool: string; args: object };

function chunk(delta: object, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function streamFor(reply: Reply): string {
  if ("tool" in reply) {
    const call = { index: 0, id: "call_1", type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } };
    return chunk({ role: "assistant", tool_calls: [call] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
  }
  return chunk({ role: "assistant", content: reply.text }) + chunk({}, "stop") + "data: [DONE]\n\n";
}

async function modelServer(script: Reply[]): Promise<{ server: Server; port: number; requests: any[] }> {
  const requests: any[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(streamFor(script[requests.length - 1] ?? { text: "Finished." }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, requests };
}

const MODES = {
  source: { PRIVATEER_NO_BOOT_BUNDLE: "1" },
  build: { PRIVATEER_BOOT_BUNDLE: "1" },
} as const;

// Loaded with -e in both modes: proves a user extension still loads, and which code ran.
const PROBE = `
import { writeFileSync } from "node:fs";
export default function (pi) {
  writeFileSync(process.env.BOOT_PROBE_OUT, new Error().stack ?? "");
}
`;

async function launch(mode: keyof typeof MODES, script: Reply[], flags: string[] = ["--no-session"]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "privateer-boot-run-"));
  const { server, port, requests } = await modelServer(script);
  fs.mkdirSync(path.join(home, "agent"));
  fs.writeFileSync(
    path.join(home, "agent", "models.json"),
    JSON.stringify({ providers: { stub: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "stub", models: [{ id: "stub-model" }] } } }),
  );
  const probe = path.join(home, "probe.ts");
  const probeOut = path.join(home, "probe.txt");
  fs.writeFileSync(probe, PROBE);
  const args = [LAUNCHER, "-p", "--mode", "json", ...flags, "--provider", "stub", "--model", "stub-model", "-e", probe, "go"];
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, PRIVATEER_HOME: home, BOOT_PROBE_OUT: probeOut, ...MODES[mode] },
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.resume();
  const limit = setTimeout(() => child.kill("SIGKILL"), 90_000);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(limit);
  server.close();
  return { code, stderr, home, requests, stack: fs.readFileSync(probeOut, "utf8") };
}

const toolNames = (request: any): string[] => (request.tools ?? []).map((t: any) => t.function.name).sort();
const toolResult = (request: any): string => JSON.stringify(request.messages.filter((m: any) => m.role === "tool").at(-1)?.content ?? "");

// Writes the build once for the whole file, then removes it unless one was already there.
let builtHere = false;
before(async () => {
  if (skip) return;
  builtHere = !fs.existsSync(path.join(REPO, "dist-boot", "boot.mjs"));
  await buildBoot({ quiet: true });
});
after(() => {
  if (builtHere) fs.rmSync(path.join(REPO, "dist-boot"), { recursive: true, force: true });
});

test("the build offers the model exactly the tools source does", { skip }, async () => {
  const [src, built] = [await launch("source", [{ text: "Hi." }]), await launch("build", [{ text: "Hi." }])];
  assert.equal(src.code, 0, src.stderr);
  assert.equal(built.code, 0, built.stderr);
  assert.doesNotMatch(built.stderr, /Failed to load extension/);
  assert.match(built.stack, /dist-boot/, "this run must really have come from the build");
  assert.doesNotMatch(src.stack, /dist-boot/, "this run must really have come from source");
  assert.ok(toolNames(built.requests[0]).includes("bash"));
  assert.ok(toolNames(built.requests[0]).includes("web_search"), "signed out, this comes from the optional web pack");
  assert.deepEqual(toolNames(built.requests[0]), toolNames(src.requests[0]));
});

test("the permission gate stops the same command in the build as in source", { skip }, async () => {
  const script: Reply[] = [{ tool: "bash", args: { command: "rm -rf ./gate-probe-dir; touch gate-ran.txt" } }, { text: "Done." }];
  const [src, built] = [await launch("source", script), await launch("build", script)];
  assert.equal(built.code, src.code, built.stderr);
  assert.equal(fs.existsSync(path.join(src.home, "gate-ran.txt")), false, "source must block this");
  assert.equal(fs.existsSync(path.join(built.home, "gate-ran.txt")), false, "the build must block this too");
  assert.equal(toolResult(built.requests[1]), toolResult(src.requests[1]), "the model must be told the same thing");
});

test("sessions written from the build are sealed at rest", { skip }, async () => {
  const { code, stderr, home } = await launch("build", [{ text: "Hi." }], []);
  assert.equal(code, 0, stderr);
  const sessions = path.join(home, "agent", "sessions");
  const files = (fs.readdirSync(sessions, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl"));
  assert.ok(files.length > 0, "the run must have written a session");
  const lines = fs.readFileSync(path.join(sessions, files[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const body = lines.filter((l) => l.type !== "session");
  assert.ok(body.length > 0);
  assert.ok(body.every((l) => isSealed(l)), "a message reached disk in plaintext");
});
