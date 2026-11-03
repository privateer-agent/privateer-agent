// Session sealing — Pi's session transcripts, encrypted at rest.
//
// Pi writes every conversation to ~/.privateer/agent/sessions/<cwd>/<ts>_<id>.jsonl,
// one JSON entry per line, and until now in plaintext: every prompt, every reply,
// every file the agent read and every command's output, readable by anything that
// can read the home directory — backup and sync tools, indexers, a stray `grep -r`,
// any other program the user runs.
//
// Now each line except the header is sealed with AES-256-GCM:
//     {"pvs":1,"iv":"<b64 12 bytes>","ct":"<b64 ciphertext‖tag>"}
// The HEADER (type "session": id, timestamp, cwd) stays readable on purpose. Pi
// finds and lists sessions by reading only the first line of each file, and the cwd
// it holds is already spelled out in the directory name, so sealing it would cost
// session discovery and hide nothing.
//
// The patch in patches/@earendil-works+pi-coding-agent+*.patch routes Pi's reads
// (parseSessionEntryLine / parseSessionEntries) and writes (every JSON.stringify of
// an entry) through the codec this module installs on globalThis. Without the codec
// — Pi run by hand, outside `privateer` — Pi writes plaintext as before, and sealed
// lines read as absent rather than as garbage. Readers accept both forms forever, so
// files written before this change, and files of mixed form, keep working.
//
// THE KEY, AND WHAT THIS DOES NOT DO. One random 32-byte key per machine, in
// $PRIVATEER_HOME/session-key.json (0600) — next to the data, like this tool's other
// secrets (terminal-key.json, credentials). So this protects transcripts from
// anything that reads the session FILES (indexers, a shared or synced sessions
// folder, an attachment pasted from the wrong directory, tools that scan for
// .jsonl), and it does NOT protect them from someone who can read the whole
// ~/.privateer as this user: that reader has the key too. Say exactly that, never
// more. An OS keychain would move the key out of the folder, at the price of
// sessions that can't open over ssh or with the keychain locked — a different
// trade, not a free upgrade.
//
// Never mint a key over one that exists: a second key orphans every session sealed
// under the first. A key file that is present but unreadable or malformed is an
// error (sealing is switched off and the user is told), never a reason to start over.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CODEC_KEY = Symbol.for("privateer.sessionCodec");
const KEY_FILE = "session-key.json";

export function keyPath(home) {
  return path.join(home, KEY_FILE);
}

function parseKeyFile(text) {
  const parsed = JSON.parse(text);
  const key = Buffer.from(String(parsed?.key ?? ""), "base64");
  if (parsed?.v !== 1 || key.length !== 32) throw new Error("session key file is malformed");
  return key;
}

/**
 * Load this machine's session key, minting it only when no key file exists at all.
 * Two terminals starting at once race on `wx`: the loser re-reads the winner's key.
 */
export function loadOrCreateKey(home) {
  const file = keyPath(home);
  try {
    return parseKeyFile(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, JSON.stringify({ v: 1, key: key.toString("base64"), created: new Date().toISOString() }) + "\n", { mode: 0o600, flag: "wx" });
    return key;
  } catch (e) {
    if (e?.code === "EEXIST") return parseKeyFile(fs.readFileSync(file, "utf8"));
    throw e;
  }
}

export function isSealed(obj) {
  return !!obj && typeof obj === "object" && obj.pvs === 1 && typeof obj.iv === "string" && typeof obj.ct === "string";
}

/** One entry → one line (no newline). The session header is never sealed. */
export function encodeEntry(entry, key) {
  if (entry?.type === "session") return JSON.stringify(entry);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(entry), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ pvs: 1, iv: iv.toString("base64"), ct: ct.toString("base64") });
}

/** A parsed line → the entry. Plaintext passes through; a line that fails to open → null. */
export function decodeEntry(obj, key) {
  if (!isSealed(obj)) return obj;
  try {
    const iv = Buffer.from(obj.iv, "base64");
    const raw = Buffer.from(obj.ct, "base64");
    if (iv.length !== 12 || raw.length < 17) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const text = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Install the codec Pi's patched session manager calls. Returns { ok, error? }.
 * `failures` counts lines that would not open (a different machine's key, a damaged
 * file), so the agent can say so instead of showing a silently shorter session.
 */
export function installCodec(home) {
  let key;
  try {
    key = loadOrCreateKey(home);
  } catch (e) {
    delete globalThis[CODEC_KEY];
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const codec = {
    failures: 0,
    encode: (entry) => encodeEntry(entry, key),
    decode: (obj) => {
      const out = decodeEntry(obj, key);
      if (out === null) codec.failures++;
      return out;
    },
  };
  globalThis[CODEC_KEY] = codec;
  return { ok: true };
}

/**
 * Seal one existing file in place. Lines that are already sealed, the header, and
 * lines that don't parse are carried over byte-for-byte (a malformed line is Pi's to
 * skip, not ours to drop). Written to a sibling temp file, VERIFIED by reading it
 * back, then renamed over the original only if the original hasn't changed since it
 * was read — a session another terminal is appending to is left for a later pass.
 * The file keeps its original atime/mtime (Pi sorts sessions by mtime).
 * Returns "sealed" | "unchanged" | "busy" | "failed".
 */
export function sealFile(file, key) {
  let before, text;
  try {
    before = fs.statSync(file);
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "failed";
  }
  const lines = text.split("\n");
  let changed = false;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return line;
    }
    if (isSealed(obj) || obj?.type === "session") return line;
    changed = true;
    return encodeEntry(obj, key);
  });
  if (!changed) return "unchanged";

  // Verify: every original entry must come back identical from what we will write.
  for (let i = 0; i < lines.length; i++) {
    if (out[i] === lines[i]) continue;
    const back = decodeEntry(JSON.parse(out[i]), key);
    if (JSON.stringify(back) !== JSON.stringify(JSON.parse(lines[i]))) return "failed";
  }

  const tmp = `${file}.sealing-${process.pid}`;
  try {
    fs.writeFileSync(tmp, out.join("\n"), { mode: 0o600 });
    const now = fs.statSync(file);
    if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
      fs.rmSync(tmp, { force: true });
      return "busy";
    }
    // Keep the original times: Pi orders sessions by mtime (`privateer -c` continues
    // the most recent one), so a conversion must not make an old session look new.
    fs.utimesSync(tmp, before.atime, before.mtime);
    fs.renameSync(tmp, file);
    return "sealed";
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    return "failed";
  }
}

/** Every session file under Pi's sessions dir. */
export function listSessionFiles(sessionsDir) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(sessionsDir, d.name);
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith(".jsonl")) out.push(path.join(dir, f));
    } catch { /* unreadable folder: skip */ }
  }
  return out;
}

/**
 * Seal every plaintext session on this machine — once, then never again. Files
 * touched in the last QUIET_MS are skipped (another terminal may be writing them);
 * the done-marker is only written when nothing was skipped or failed, so a later
 * launch finishes the job. Async-yielding so the launcher's event loop stays live.
 */
export const QUIET_MS = 10 * 60 * 1000;
export async function sweepSessions(home, sessionsDir, { now = Date.now(), quietMs = QUIET_MS } = {}) {
  const done = path.join(home, "run", "sessions-sealed-v1");
  if (fs.existsSync(done)) return { skipped: true };
  let key;
  try {
    key = loadOrCreateKey(home);
  } catch {
    return { error: true };
  }
  const tally = { sealed: 0, unchanged: 0, busy: 0, failed: 0, recent: 0 };
  for (const file of listSessionFiles(sessionsDir)) {
    try {
      if (now - fs.statSync(file).mtimeMs < quietMs) { tally.recent++; continue; }
    } catch { continue; }
    tally[sealFile(file, key)]++;
    await new Promise((r) => setImmediate(r));
  }
  if (!tally.busy && !tally.failed && !tally.recent) {
    try {
      fs.mkdirSync(path.dirname(done), { recursive: true, mode: 0o700 });
      fs.writeFileSync(done, new Date().toISOString() + "\n", { mode: 0o600 });
    } catch { /* retried next launch */ }
  }
  return tally;
}
