// Deferred media jobs (image/speech/music/sfx): submit → poll → open the SEALED
// result locally. A stub server stands in for Privateer; it seals exactly as
// treeview/server/services/agentMediaJobs.js does (AES-256-GCM, iv|tag|ct).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pv-deferred-"));
process.env.PRIVATEER_HOME = home;
process.env.PRIVATEER_SERVER_URL = "https://stub.privateer.test";

let media: typeof import("../src/tools/media.ts");

before(async () => {
  const auth = await import("../src/auth/privateer.ts");
  auth.saveCredentials({
    accessToken: "parent", refreshToken: "r",
    user: { id: "u1" } as never, serverBaseUrl: "https://stub.privateer.test",
  });
  media = await import("../src/tools/media.ts");
});

function seal(key: Buffer, status: number, body: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify({ status, body: JSON.stringify(body) })), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

interface Stub { seen: string[]; restore: () => void }
function stubServer(opts: { result?: { status: number; body: unknown }; noJobsRoute?: boolean; pending?: number }): Stub {
  const real = globalThis.fetch;
  const seen: string[] = [];
  const keys = new Map<string, Buffer>();
  let pending = opts.pending ?? 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    seen.push(`${method} ${url.pathname}`);
    if (url.pathname === "/auth/session/spawn") return json(200, { accessToken: "child", refreshToken: "cr" });
    if (url.pathname === "/api/agent/media/jobs" && method === "POST") {
      if (opts.noJobsRoute) return json(404, { message: "Not found" });
      const { sealKey } = JSON.parse(String(init.body));
      const id = `amj_${randomBytes(6).toString("hex")}`;
      keys.set(id, Buffer.from(sealKey, "base64"));
      return json(202, { jobId: id, status: "processing" });
    }
    const m = /^\/api\/agent\/media\/jobs\/(amj_[0-9a-f]+)$/.exec(url.pathname);
    if (m && method === "GET") {
      if (pending-- > 0) return json(200, { status: "processing" });
      const r = opts.result!;
      return json(200, { status: "done", httpStatus: r.status, sealed: seal(keys.get(m[1])!, r.status, r.body) });
    }
    if (m && method === "DELETE") return new Response(null, { status: 204 });
    if (url.pathname === "/api/agent/media/images") return json(200, opts.result!.body);
    return json(500, { message: `unexpected ${method} ${url.pathname}` });
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = real; } };
}

const PNG = { model: "m", images: [{ data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" }] };
const out = (t: { content: { text: string }[] }) => t.content[0].text;
const keyFiles = () => (existsSync(join(home, "media-jobs")) ? readdirSync(join(home, "media-jobs")) : []);

test("an image runs as a deferred job and is opened locally", async () => {
  const s = stubServer({ result: { status: 200, body: PNG } });
  try {
    const cwd = mkdtempSync(join(tmpdir(), "pv-deferred-cwd-"));
    const r = await media.generateImageToolDefinition.execute("t", { prompt: "a cat", path: "cat.png" }, undefined, undefined, { cwd });
    assert.match(out(r), /Generated 1 image/);
    assert.equal(readFileSync(join(cwd, "cat.png"), "utf8"), "png-bytes");
    assert.ok(s.seen.includes("POST /api/agent/media/jobs"));
    assert.ok(!s.seen.includes("POST /api/agent/media/images"), "must not use the blocking route");
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(s.seen.some((x) => x.startsWith("DELETE /api/agent/media/jobs/")), "collected job is acked");
    assert.deepEqual(keyFiles(), [], "the key is forgotten once collected");
  } finally { s.restore(); }
});

test("wait:false returns a job id, and resumeJobId collects it without a second submit", async () => {
  const s = stubServer({ result: { status: 200, body: PNG } });
  try {
    const cwd = mkdtempSync(join(tmpdir(), "pv-deferred-cwd-"));
    const started = out(await media.generateImageToolDefinition.execute("t", { prompt: "a dog", path: "dog.png", wait: false }, undefined, undefined, { cwd }));
    const jobId = /(amj_[0-9a-f]+)/.exec(started)![1];
    assert.match(started, /resumeJobId/);
    assert.equal(existsSync(join(cwd, "dog.png")), false);
    assert.deepEqual(keyFiles(), [`${jobId}.json`]);

    const collected = out(await media.generateImageToolDefinition.execute("t", { prompt: "", path: "dog.png", resumeJobId: jobId }, undefined, undefined, { cwd }));
    assert.match(collected, /Collected 1 image/);
    assert.equal(s.seen.filter((x) => x === "POST /api/agent/media/jobs").length, 1, "resume must not submit again");
  } finally { s.restore(); }
});

test("a sealed refusal is judged like a direct one (ZDR wording survives)", async () => {
  const s = stubServer({ result: { status: 403, body: { code: "ZDR_MEDIA_BLOCKED", message: "blocked by ZDR" } } });
  try {
    const cwd = mkdtempSync(join(tmpdir(), "pv-deferred-cwd-"));
    const r = out(await media.generateSfxToolDefinition.execute("t", { prompt: "boom", path: "b.mp3" }, undefined, undefined, { cwd }));
    assert.match(r, /blocked by ZDR/);
    assert.match(r, /do not retry/);
  } finally { s.restore(); }
});

test("a server without the jobs route falls back to the blocking call", async () => {
  const s = stubServer({ noJobsRoute: true, result: { status: 200, body: PNG } });
  try {
    const cwd = mkdtempSync(join(tmpdir(), "pv-deferred-cwd-"));
    const r = out(await media.generateImageToolDefinition.execute("t", { prompt: "a fox", path: "fox.png" }, undefined, undefined, { cwd }));
    assert.match(r, /Generated 1 image/);
    assert.ok(s.seen.includes("POST /api/agent/media/images"));
  } finally { s.restore(); }
});

test("resuming a job this machine holds no key for says so plainly", async () => {
  const s = stubServer({ result: { status: 200, body: PNG } });
  try {
    const r = out(await media.generateMusicToolDefinition.execute("t", { prompt: "", path: "x.mp3", resumeJobId: "amj_deadbeef" }, undefined, undefined, { cwd: home }));
    assert.match(r, /no key for job amj_deadbeef/);
  } finally { s.restore(); }
});

test("a job id of the wrong kind points at the right tool", async () => {
  const s = stubServer({ result: { status: 200, body: PNG } });
  try {
    const started = out(await media.generateImageToolDefinition.execute("t", { prompt: "x", path: "x.png", wait: false }, undefined, undefined, { cwd: home }));
    const jobId = /(amj_[0-9a-f]+)/.exec(started)![1];
    const r = out(await media.generateSpeechToolDefinition.execute("t", { text: "", path: "x.mp3", resumeJobId: jobId }, undefined, undefined, { cwd: home }));
    assert.match(r, /collect it with generate_image/);
  } finally { s.restore(); }
});

test("a job still processing is waited on, not reported as done", async () => {
  const s = stubServer({ pending: 1, result: { status: 200, body: { model: "tts", audioBase64: Buffer.from("mp3").toString("base64"), mimeType: "audio/mpeg" } } });
  try {
    const cwd = mkdtempSync(join(tmpdir(), "pv-deferred-cwd-"));
    const r = out(await media.generateSpeechToolDefinition.execute("t", { text: "hello", path: "hi.mp3" }, undefined, undefined, { cwd }));
    assert.match(r, /Generated speech/);
    assert.equal(s.seen.filter((x) => /^GET \/api\/agent\/media\/jobs\//.test(x)).length, 2);
  } finally { s.restore(); }
});
