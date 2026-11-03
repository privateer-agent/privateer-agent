import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  CODEC_KEY,
  decodeEntry,
  encodeEntry,
  installCodec,
  keyPath,
  loadOrCreateKey,
  sealFile,
  sweepSessions,
} from "../bin/session-seal.mjs";

// Session sealing (bin/session-seal.mjs + the session-manager hunk of the Pi patch).
// What has to hold:
//  - nothing a user typed or an agent produced is readable in a session file;
//  - the header stays readable, so Pi still finds and lists sessions cheaply;
//  - files from before sealing, and files of mixed form, open in full, forever;
//  - a key that exists is never replaced — that would orphan every sealed session;
//  - converting old files never loses a line, and never races a terminal using one.

const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `pv-seal-${n}-`));
const SECRET = "the launch code is hunter2";
const g = globalThis as any;

function withCodec<T>(home: string, fn: () => T): T {
  const prev = g[CODEC_KEY];
  assert.equal(installCodec(home).ok, true);
  try { return fn(); } finally { if (prev) g[CODEC_KEY] = prev; else delete g[CODEC_KEY]; }
}

const userMsg = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

// ── The codec ──────────────────────────────────────────────────────────────────
test("an entry round-trips; the header is never sealed", () => {
  const key = Buffer.alloc(32, 7);
  const entry = { type: "message", id: "a1", parentId: null, message: userMsg(SECRET) };
  const line = encodeEntry(entry, key);
  assert.ok(!line.includes("hunter2"));
  assert.deepEqual(decodeEntry(JSON.parse(line), key), entry);
  const header = { type: "session", version: 3, id: "s1", cwd: "/w" };
  assert.equal(encodeEntry(header, key), JSON.stringify(header));
  assert.deepEqual(decodeEntry(entry, key), entry, "plaintext passes through");
});

test("a tampered line or another machine's key opens to nothing, never to garbage", () => {
  const key = Buffer.alloc(32, 7);
  const sealed = JSON.parse(encodeEntry({ type: "message", id: "a1" }, key));
  const flipped = { ...sealed, ct: Buffer.from(Buffer.from(sealed.ct, "base64").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64") };
  assert.equal(decodeEntry(flipped, key), null);
  assert.equal(decodeEntry(sealed, Buffer.alloc(32, 8)), null);
  assert.equal(decodeEntry({ pvs: 1, iv: "x", ct: "y" }, key), null);
});

// ── The key ────────────────────────────────────────────────────────────────────
test("the key is minted once, owner-only, and reused", () => {
  const home = tmp("key");
  const a = loadOrCreateKey(home);
  assert.equal(fs.statSync(keyPath(home)).mode & 0o777, 0o600);
  assert.deepEqual(loadOrCreateKey(home), a);
});

test("a key file that exists but is broken is an error, and is left exactly as it was", () => {
  const home = tmp("badkey");
  fs.writeFileSync(keyPath(home), "{ not json");
  assert.throws(() => loadOrCreateKey(home));
  assert.equal(fs.readFileSync(keyPath(home), "utf8"), "{ not json");
  const r = installCodec(home);
  assert.equal(r.ok, false);
  assert.equal(g[CODEC_KEY], undefined, "sealing off, not sealing under a new key");
});

// ── Through Pi's own SessionManager (the patch) ────────────────────────────────
test("Pi writes a sealed session and reads it back in full", () => {
  const home = tmp("pi");
  const dir = path.join(home, "sessions");
  const file = withCodec(home, () => {
    const sm = SessionManager.create("/w", dir);
    sm.appendMessage(userMsg(SECRET) as any);
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "noted: hunter2" }], timestamp: Date.now() } as any);
    return sm.getSessionFile()!;
  });
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes("hunter2"), "no plaintext on disk");
  assert.equal(JSON.parse(raw.split("\n")[0]).type, "session", "header readable for discovery");

  const reopened = withCodec(home, () => SessionManager.open(file));
  const texts = reopened.getEntries().filter((e: any) => e.type === "message").map((e: any) => e.message.content[0].text);
  assert.deepEqual(texts, [SECRET, "noted: hunter2"]);
});

test("without the codec Pi skips sealed lines instead of crashing, and lists the session", async () => {
  const home = tmp("nocodec");
  const dir = path.join(home, "sessions");
  const file = withCodec(home, () => {
    const sm = SessionManager.create("/w", dir);
    sm.appendMessage(userMsg(SECRET) as any);
    return sm.getSessionFile()!;
  });
  delete g[CODEC_KEY];
  const sm = SessionManager.open(file);
  assert.equal(sm.getEntries().length, 0);
  const listed = await SessionManager.list("/w", dir);
  assert.equal(listed.length, 1, "discovery still works off the plaintext header");
  assert.equal(installCodec(home).ok, true);
  const withKey = await SessionManager.list("/w", dir).finally(() => { delete g[CODEC_KEY]; });
  assert.equal(withKey[0].firstMessage, SECRET, "the session list shows the first message when the key is present");
});

test("a pre-sealing file opens in full and keeps working as new lines are sealed onto it", () => {
  const home = tmp("legacy");
  const dir = path.join(home, "sessions");
  const legacy = (() => {
    const sm = SessionManager.create("/w", dir); // no codec: plaintext, as before this change
    sm.appendMessage(userMsg("old message") as any);
    return sm.getSessionFile()!;
  })();
  withCodec(home, () => {
    const sm = SessionManager.open(legacy);
    sm.appendMessage(userMsg("new message") as any);
  });
  const raw = fs.readFileSync(legacy, "utf8");
  assert.ok(raw.includes("old message") && !raw.includes("new message"), "mixed form on disk");
  const texts = withCodec(home, () => SessionManager.open(legacy)).getEntries()
    .filter((e: any) => e.type === "message").map((e: any) => e.message.content[0].text);
  assert.deepEqual(texts, ["old message", "new message"]);
});

// ── Converting what is already on disk ─────────────────────────────────────────
test("sealFile seals in place, keeps the header and malformed lines, and is idempotent", () => {
  const home = tmp("sealfile");
  const key = loadOrCreateKey(home);
  const file = path.join(home, "s.jsonl");
  const header = JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/w" });
  const msg = JSON.stringify({ type: "message", id: "a1", parentId: null, message: userMsg(SECRET) });
  fs.writeFileSync(file, [header, msg, "{broken", ""].join("\n"), { mode: 0o644 });
  assert.equal(sealFile(file, key), "sealed");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  assert.equal(lines[0], header);
  assert.equal(lines[2], "{broken", "Pi's to skip, not ours to drop");
  assert.ok(!lines[1].includes("hunter2"));
  assert.deepEqual(decodeEntry(JSON.parse(lines[1]), key), JSON.parse(msg));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(sealFile(file, key), "unchanged");
});

test("sealing keeps the file's mtime, so `privateer -c` still continues the right session", () => {
  const home = tmp("mtime");
  const key = loadOrCreateKey(home);
  const file = path.join(home, "s.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "message", id: "a1", message: userMsg(SECRET) }) + "\n");
  const longAgo = new Date(Date.now() - 86400_000);
  fs.utimesSync(file, longAgo, longAgo);
  assert.equal(sealFile(file, key), "sealed");
  assert.equal(Math.round(fs.statSync(file).mtimeMs / 1000), Math.round(longAgo.getTime() / 1000));
});

test("the sweep leaves recently-used sessions for later and only marks itself done when nothing was left", async () => {
  const home = tmp("sweep");
  const sessions = path.join(home, "sessions", "--w--");
  fs.mkdirSync(sessions, { recursive: true });
  const msg = JSON.stringify({ type: "message", id: "a1", parentId: null, message: userMsg(SECRET) });
  const old = path.join(sessions, "old.jsonl");
  const fresh = path.join(sessions, "fresh.jsonl");
  fs.writeFileSync(old, msg + "\n");
  fs.writeFileSync(fresh, msg + "\n");
  const longAgo = new Date(Date.now() - 3600_000);
  fs.utimesSync(old, longAgo, longAgo);

  const first: any = await sweepSessions(home, path.join(home, "sessions"));
  assert.deepEqual([first.sealed, first.recent], [1, 1]);
  assert.ok(!fs.readFileSync(old, "utf8").includes("hunter2"));
  assert.ok(fs.readFileSync(fresh, "utf8").includes("hunter2"), "possibly open in another terminal: not touched");
  assert.equal(fs.existsSync(path.join(home, "run", "sessions-sealed-v1")), false);

  fs.utimesSync(fresh, longAgo, longAgo);
  const second: any = await sweepSessions(home, path.join(home, "sessions"));
  assert.equal(second.sealed, 1);
  assert.equal(fs.existsSync(path.join(home, "run", "sessions-sealed-v1")), true);
  assert.deepEqual(await sweepSessions(home, path.join(home, "sessions")), { skipped: true });
});
