import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openE2eeChannel,
  requestAad,
  responseAad,
  toHex,
  fromHex,
  type AttestationReport,
  type ReportVerification,
} from "../src/providers/phala/aci-verifier/index.ts";

// Proves the vendored @dstack/aci-verifier E2EE channel runs correctly on Node's
// native Web Crypto (no polyfills) by simulating the enclave side end-to-end:
//   client(seal) → [service private key decrypts]  — the request path
//   [enclave encrypts to client pub] → client(open) — the response path
// Both directions reconstruct the exact AAD + HKDF/AES-GCM the channel uses, so a
// pass means seal/open, the wire format, and the AAD binding all agree in Node.

const ALGO = "x25519-aes-256-gcm-hkdf-sha256";
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const HKDF_INFO = enc.encode("aci.e2ee.v2.x25519"); // must match e2ee-channel.ts

const bs = (u: Uint8Array): BufferSource => u as BufferSource;

async function aesKey(shared: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const hk = await subtle.importKey("raw", bs(shared), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: bs(new Uint8Array(0)), info: bs(HKDF_INFO) },
    hk,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

// The enclave side of one field: X25519(ephemeral → peerPub) → HKDF → AES-GCM,
// blob = ephPub(32) | iv(12) | ciphertext. Mirrors e2ee-channel.ts sealField.
async function sealTo(peerRawPub: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<string> {
  const eph = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const ephPub = new Uint8Array(await subtle.exportKey("raw", eph.publicKey));
  const peer = await subtle.importKey("raw", bs(peerRawPub), { name: "X25519" }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: peer }, eph.privateKey, 256));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(aad) }, await aesKey(shared, "encrypt"), bs(plaintext)),
  );
  const blob = new Uint8Array(ephPub.length + iv.length + ct.length);
  blob.set(ephPub);
  blob.set(iv, ephPub.length);
  blob.set(ct, ephPub.length + iv.length);
  return toHex(blob);
}

// Decrypt a client-sealed field with the service private key (the enclave's role).
async function openWith(servicePriv: CryptoKey, blobHex: string, aad: Uint8Array): Promise<Uint8Array> {
  const blob = fromHex(blobHex);
  const ephPub = await subtle.importKey("raw", bs(blob.slice(0, 32)), { name: "X25519" }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: ephPub }, servicePriv, 256));
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: bs(blob.slice(32, 44)), additionalData: bs(aad) },
    await aesKey(shared, "decrypt"),
    bs(blob.slice(44)),
  );
  return new Uint8Array(pt);
}

// A minimal report/verification that openE2eeChannel accepts: it only needs
// verification.ok, a matching workload_keyset_digest, and an attested ALGO key.
async function fixture(): Promise<{ report: AttestationReport; verification: ReportVerification; servicePriv: CryptoKey }> {
  const service = (await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const servicePubHex = toHex(new Uint8Array(await subtle.exportKey("raw", service.publicKey)));
  const digest = "test-keyset-digest";
  const report = {
    api_version: "1",
    workload_id: "w",
    workload_keyset_digest: digest,
    attestation: {
      workload_keyset: { e2ee_public_keys: [{ algo: ALGO, public_key: servicePubHex }] },
      report_data: "",
      keyset_endorsement: { algo: "ed25519", value: "" },
    },
  } as unknown as AttestationReport;
  const verification: ReportVerification = { ok: true, checks: [], workloadId: "w", workloadKeysetDigest: digest };
  return { report, verification, servicePriv: service.privateKey };
}

test("seal encrypts message content to the attested key (client → enclave)", async () => {
  const { report, verification, servicePriv } = await fixture();
  const channel = await openE2eeChannel(report, verification);

  const secret = "the secret prompt";
  const { body, headers } = await channel.seal({ model: "m", messages: [{ role: "user", content: secret }] });

  // The content field is now ciphertext, not the plaintext.
  const sealed = (body.messages as Array<{ content: string }>)[0].content;
  assert.notEqual(sealed, secret);
  assert.match(sealed, /^[0-9a-f]+$/); // hex blob
  assert.equal(headers["X-E2EE-Version"], "2");
  assert.ok(headers["X-Client-Pub-Key"] && headers["X-E2EE-Nonce"] && headers["X-E2EE-Timestamp"]);

  // The enclave (service private key) recovers the plaintext with the request AAD.
  const aad = requestAad({
    algo: ALGO,
    model: "m",
    field: "messages.0.content",
    nonce: headers["X-E2EE-Nonce"],
    ts: Number(headers["X-E2EE-Timestamp"]),
  });
  const recovered = dec.decode(await openWith(servicePriv, sealed, aad));
  assert.equal(recovered, secret);
});

test("open decrypts an enclave response bound to the request (enclave → client)", async () => {
  const { report, verification } = await fixture();
  const channel = await openE2eeChannel(report, verification);

  const { headers } = await channel.seal({ model: "m", messages: [{ role: "user", content: "hi" }] });
  const clientPub = fromHex(headers["X-Client-Pub-Key"]);
  const nonce = headers["X-E2EE-Nonce"];
  const ts = Number(headers["X-E2EE-Timestamp"]);

  // Enclave seals a reply field to the client's static key, with the response AAD.
  const reply = "hello from the enclave";
  const id = "resp-1";
  const aad = responseAad({ algo: ALGO, model: "m", id, field: "choices.0.message.content", nonce, ts });
  const sealedReply = await sealTo(clientPub, enc.encode(reply), aad);

  const response = {
    id,
    choices: [{ index: 0, message: { role: "assistant", content: sealedReply } }],
  };
  const opened = await channel.open(response);
  const content = (opened.choices as Array<{ message: { content: string } }>)[0].message.content;
  assert.equal(content, reply);
});

test("openChunk decrypts a streamed SSE delta bound to the request", async () => {
  const { report, verification } = await fixture();
  const channel = await openE2eeChannel(report, verification);

  const { headers } = await channel.seal({ model: "m", messages: [{ role: "user", content: "hi" }] });
  const clientPub = fromHex(headers["X-Client-Pub-Key"]);
  const nonce = headers["X-E2EE-Nonce"];
  const ts = Number(headers["X-E2EE-Timestamp"]);

  const delta = "streamed token";
  const id = "chunk-1";
  const aad = responseAad({ algo: ALGO, model: "m", id, field: "choices.0.delta.content", nonce, ts });
  const sealedDelta = await sealTo(clientPub, enc.encode(delta), aad);

  const chunk = { id, choices: [{ index: 0, delta: { content: sealedDelta } }] };
  const opened = await channel.openChunk(chunk);
  const content = (opened.choices as Array<{ delta: { content: string } }>)[0].delta.content;
  assert.equal(content, delta);
});
