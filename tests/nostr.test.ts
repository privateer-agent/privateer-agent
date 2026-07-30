import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { serializeEvent, eventId, signEvent, verifyEvent, type UnsignedEvent } from "../src/nostr/event.ts";
import { bech32Encode, bech32Decode, npubEncode, npubDecode, nsecEncode, nsecDecode } from "../src/nostr/bech32.ts";
import { threadRefs, pTags, xTags, replyTags } from "../src/nostr/tags.ts";
import {
  generateSecretKey,
  publicKeyHex,
  toHexPubkey,
  secretFromNsec,
  loadOrCreateBuzzKey,
  importBuzzKey,
  peekBuzzNpub,
} from "../src/nostr/keys.ts";

// ── event.ts ────────────────────────────────────────────────────────────────────

// The NIP-01 serialization is the single most fragile thing in the whole Nostr
// stack: it is positional, and any drift in field order or JSON form silently
// changes every id we compute (and therefore every signature the relay checks).
// So we pin the exact expected STRING, hand-written from the spec, and derive the
// id from it — rather than hardcoding an id hex that could only ever agree with
// whatever serializeEvent happens to produce.
const FIXTURE: UnsignedEvent = {
  pubkey: "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240",
  created_at: 1700000000,
  kind: 1,
  tags: [
    ["e", "aaaa", "", "root"],
    ["p", "bbbb"],
  ],
  content: "hello nostr",
};
const FIXTURE_SERIALIZED =
  '[0,"84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240",1700000000,1,' +
  '[["e","aaaa","","root"],["p","bbbb"]],"hello nostr"]';

test("serializeEvent emits the NIP-01 positional array, exactly", () => {
  assert.equal(serializeEvent(FIXTURE), FIXTURE_SERIALIZED);
});

test("eventId is sha256 of that serialization", () => {
  assert.equal(eventId(FIXTURE), bytesToHex(sha256(utf8ToBytes(FIXTURE_SERIALIZED))));
  assert.equal(eventId(FIXTURE).length, 64);
});

test("serializeEvent escapes control characters the way every relay expects", () => {
  const ev = { ...FIXTURE, content: 'line1\nline2\t"quoted"\\' };
  // JSON.stringify's escaping is what NIP-01 mandates for these characters.
  assert.ok(serializeEvent(ev).includes('line1\\nline2\\t\\"quoted\\"\\\\'));
});

test("BIP-340 published vector 1 reproduces exactly (pins the noble wiring)", () => {
  const sk = "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef";
  const msg = "243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89";
  const aux = "0000000000000000000000000000000000000000000000000000000000000001";
  assert.equal(publicKeyHex(sk), "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659");
  assert.equal(
    bytesToHex(schnorr.sign(hexToBytes(msg), hexToBytes(sk), hexToBytes(aux))),
    "6896bd60eeae296db48a229ff71dfe071bde413e6d43f917dc8dcf8c78de3341" +
      "8906d11ac976abccb20b091292bff4ea897efcb639ea871cfa95f6de339e4b0a",
  );
});

test("BIP-340 published vector 4 verifies (signature-only vector)", () => {
  assert.equal(
    schnorr.verify(
      hexToBytes(
        "00000000000000000000003b78ce563f89a0ed9414f5aa28ad0d96d6795f9c63" +
          "76afb1548af603b3eb45c9f8207dee1060cb71c04e80f593060b07d28308d7f4",
      ),
      hexToBytes("4df3c3f68fcc83b27e9d42c90431a72499f17875c81a599b566c9889b9696703"),
      hexToBytes("d69c3509bb99e412e68b0fe8544e72837dfa30746d8be2aa65975f29d22dc7b9"),
    ),
    true,
  );
});

test("signEvent → verifyEvent round-trips", () => {
  const sk = bytesToHex(generateSecretKey());
  const ev = signEvent({ ...FIXTURE, pubkey: publicKeyHex(sk) }, sk);
  assert.equal(ev.id, eventId({ ...FIXTURE, pubkey: publicKeyHex(sk) }));
  assert.equal(ev.sig.length, 128);
  assert.equal(verifyEvent(ev), true);
});

test("verifyEvent rejects tampered content — proves the id is RECOMPUTED, not trusted", () => {
  const sk = bytesToHex(generateSecretKey());
  const ev = signEvent({ ...FIXTURE, pubkey: publicKeyHex(sk) }, sk);
  // The signature over the ORIGINAL id is still perfectly valid here; only the
  // id-recompute step catches this.
  assert.equal(verifyEvent({ ...ev, content: "hello nostr!" }), false);
  assert.equal(verifyEvent({ ...ev, kind: 7 }), false);
  assert.equal(verifyEvent({ ...ev, tags: [] }), false);
});

test("verifyEvent fails closed on malformed input rather than throwing", () => {
  const sk = bytesToHex(generateSecretKey());
  const ev = signEvent({ ...FIXTURE, pubkey: publicKeyHex(sk) }, sk);
  assert.equal(verifyEvent({ ...ev, sig: "zz" }), false);
  assert.equal(verifyEvent({ ...ev, id: "short" }), false);
  assert.equal(verifyEvent({ ...ev, pubkey: "nope" }), false);
  assert.equal(verifyEvent(undefined as any), false);
  assert.equal(verifyEvent({ ...ev, tags: undefined as any }), false);
});

// ── bech32.ts ───────────────────────────────────────────────────────────────────

// The published NIP-19 vectors.
const NPUB = "npub1sn0wdenkukak0d9dfczzeacvhkrgz92ak56egt7vdgzn8pv2wfqqhrjdv9";
const NPUB_HEX = "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240";
const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
const NSEC_HEX = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";

test("BIP-173 vectors pin the checksum algorithm independently of Nostr", () => {
  // These verify the polymod/hrpExpand implementation against the bech32 spec
  // itself, so the NIP-19 assertions below aren't merely self-consistent.
  for (const [s, hrp] of [
    ["A12UEL5L", "a"],
    ["a12uel5l", "a"],
    ["abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw", "abcdef"], // full charset
    ["split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w", "split"],
  ] as const) {
    assert.equal(bech32Decode(s).hrp, hrp, `expected ${s} to decode`);
  }
  // Invalid per BIP-173: bad checksum, and an HRP-position separator error.
  assert.throws(() => bech32Decode("A1G7SGD8"), /checksum/);
  assert.throws(
    () => bech32Decode("spl1t1checkupstagehandshakeupstreamerranterredcaperred2y9e2w"),
    /checksum/,
  );
  assert.throws(() => bech32Decode("li1dgmt3"), /malformed/);
});

test("NIP-19 published npub/nsec vectors decode and re-encode", () => {
  assert.equal(bytesToHex(npubDecode(NPUB)), NPUB_HEX);
  assert.equal(bytesToHex(nsecDecode(NSEC)), NSEC_HEX);
  assert.equal(npubEncode(hexToBytes(NPUB_HEX)), NPUB);
  assert.equal(nsecEncode(hexToBytes(NSEC_HEX)), NSEC);
});

test("bech32 rejects a corrupted checksum, wrong HRP, bad charset and mixed case", () => {
  // Flip one payload character — the checksum must catch it.
  const corrupted = NPUB.slice(0, 20) + (NPUB[20] === "q" ? "p" : "q") + NPUB.slice(21);
  assert.throws(() => npubDecode(corrupted), /checksum/);
  // An nsec is a perfectly valid bech32 string — it just isn't an npub.
  assert.throws(() => npubDecode(NSEC), /expected an npub/);
  assert.throws(() => nsecDecode(NPUB), /expected an nsec/);
  assert.throws(() => bech32Decode("npub1bio"), /malformed|character/);
  assert.throws(() => bech32Decode(NPUB.slice(0, 10).toUpperCase() + NPUB.slice(10)), /mixed case/);
});

test("bech32 never silently truncates a mistyped key", () => {
  // A well-formed bech32 string carrying the wrong number of bytes must throw, not
  // hand back a short key that would then sign as a different identity.
  const short = bech32Encode("nsec", new Uint8Array(31).fill(7));
  assert.throws(() => nsecDecode(short), /32 key bytes/);
});

// ── tags.ts ─────────────────────────────────────────────────────────────────────

test("threadRefs reads the markered NIP-10 form", () => {
  assert.deepEqual(
    threadRefs([
      ["e", "root-id", "", "root"],
      ["e", "parent-id", "", "reply"],
      ["p", "someone"],
    ]),
    { root: "root-id", reply: "parent-id" },
  );
});

test("threadRefs reads the legacy positional form", () => {
  // One "e" tag → it is both the root and the parent.
  assert.deepEqual(threadRefs([["e", "only-id"]]), { root: "only-id", reply: "only-id" });
  // Several → first is the root, last is the direct parent.
  assert.deepEqual(
    threadRefs([
      ["e", "root-id"],
      ["e", "middle-id"],
      ["e", "parent-id"],
    ]),
    { root: "root-id", reply: "parent-id" },
  );
});

test("threadRefs prefers explicit markers over position when both appear", () => {
  assert.deepEqual(
    threadRefs([
      ["e", "positional-first"],
      ["e", "marked-root", "", "root"],
    ]),
    { root: "marked-root", reply: undefined },
  );
});

test("threadRefs returns empty for an unthreaded event", () => {
  assert.deepEqual(threadRefs([["p", "someone"]]), {});
  assert.deepEqual(threadRefs([]), {});
});

test("pTags and xTags ignore malformed entries", () => {
  const tags = [["p", "aa"], ["p", ""], ["p"], ["x", "sha1"], ["e", "nope"], ["x", "sha2"]];
  assert.deepEqual(pTags(tags), ["aa"]);
  assert.deepEqual(xTags(tags), ["sha1", "sha2"]);
});

test("replyTags builds root/reply markers and dedupes mentions", () => {
  assert.deepEqual(replyTags("root-id", "parent-id", ["a", "b", "a"]), [
    ["e", "root-id", "", "root"],
    ["e", "parent-id", "", "reply"],
    ["p", "a"],
    ["p", "b"],
  ]);
  // A top-level reply: root === parent, so only the root marker is emitted.
  assert.deepEqual(replyTags("root-id", "root-id"), [["e", "root-id", "", "root"]]);
  assert.deepEqual(replyTags(), []);
});

// ── keys.ts ─────────────────────────────────────────────────────────────────────

test("toHexPubkey normalizes npub and hex, and fails closed on junk", () => {
  assert.equal(toHexPubkey(NPUB), NPUB_HEX);
  assert.equal(toHexPubkey(NPUB_HEX.toUpperCase()), NPUB_HEX);
  assert.equal(toHexPubkey(`  ${NPUB}  `), NPUB_HEX);
  // A typo'd allowlist entry must drop out, never match-nothing-forever silently.
  assert.equal(toHexPubkey("npub1notarealkey"), undefined);
  assert.equal(toHexPubkey("12345"), undefined);
  assert.equal(toHexPubkey(""), undefined);
});

test("secretFromNsec accepts nsec and hex, rejects anything else", () => {
  assert.equal(bytesToHex(secretFromNsec(NSEC)), NSEC_HEX);
  assert.equal(bytesToHex(secretFromNsec(NSEC_HEX)), NSEC_HEX);
  assert.throws(() => secretFromNsec("hunter2"), /nsec1/);
});

// Each key-file test needs its own PRIVATEER_HOME *and* a fresh module instance,
// because loadOrCreateBuzzKey caches for the process lifetime by design.
async function withHome(fn: (home: string, keys: typeof import("../src/nostr/keys.ts")) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "priv-buzzkey-"));
  const prev = process.env.PRIVATEER_HOME;
  process.env.PRIVATEER_HOME = home;
  try {
    const keys = await import(`../src/nostr/keys.ts?home=${encodeURIComponent(home)}`);
    await fn(home, keys);
  } finally {
    if (prev === undefined) delete process.env.PRIVATEER_HOME;
    else process.env.PRIVATEER_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

test("loadOrCreateBuzzKey mints a stable identity and persists it 0600", async () => {
  await withHome(async (home, keys) => {
    const a = keys.loadOrCreateBuzzKey();
    assert.equal(a.pubkeyHex.length, 64);
    assert.ok(a.npub.startsWith("npub1"));
    assert.equal(a.pubkeyHex, keys.publicKeyHex(a.secretHex));
    assert.equal(bytesToHex(npubDecode(a.npub)), a.pubkeyHex);

    // Stable across calls.
    assert.deepEqual(keys.loadOrCreateBuzzKey(), a);

    // A permanent identity gets owner-only permissions, like terminal-key.json.
    const mode = statSync(join(home, "buzz-key.json")).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  });
});

test("peekBuzzNpub does NOT mint an identity", async () => {
  await withHome(async (home, keys) => {
    // Merely listing an unconfigured Buzz platform in the app must not conjure a
    // permanent keypair as a side effect.
    assert.equal(keys.peekBuzzNpub(), undefined);
    assert.throws(() => statSync(join(home, "buzz-key.json")));
    const created = keys.loadOrCreateBuzzKey();
    assert.equal(keys.peekBuzzNpub(), created.npub);
  });
});

test("importBuzzKey adopts an existing nsec and replaces the generated one", async () => {
  await withHome(async (home, keys) => {
    const generated = keys.loadOrCreateBuzzKey();
    const imported = keys.importBuzzKey(NSEC);
    assert.equal(imported.secretHex, NSEC_HEX);
    assert.notEqual(imported.pubkeyHex, generated.pubkeyHex);
    assert.equal(keys.loadOrCreateBuzzKey().pubkeyHex, imported.pubkeyHex);
    assert.equal((statSync(join(home, "buzz-key.json")).mode & 0o777).toString(8), "600");
  });
});

// Keep the top-level imports referenced so an accidental unused-import cleanup can't
// silently drop coverage of the non-cached entry points.
test("module entry points are exported", () => {
  assert.equal(typeof loadOrCreateBuzzKey, "function");
  assert.equal(typeof importBuzzKey, "function");
  assert.equal(typeof peekBuzzNpub, "function");
  assert.equal(typeof generateSecretKey, "function");
});
