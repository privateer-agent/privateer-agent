// The vendored @dstack/aci-verifier (and our phalaSeal) use the WebCrypto DOM
// global type names — CryptoKey, CryptoKeyPair, KeyUsage, BufferSource. This
// project's tsconfig `lib` is ES2023 (no DOM), so rather than pull the entire DOM
// lib into a Node CLI (which would add a pile of browser globals and ambiguate
// things like `fetch`), surface just those four names as globals, aliased to
// Node's own `webcrypto` types. Node ≥ 22 provides the runtime (X25519/HKDF/
// AES-GCM/Ed25519 on globalThis.crypto.subtle) — see the VENDORED.md note.
import type { webcrypto } from "node:crypto";

declare global {
  type CryptoKey = webcrypto.CryptoKey;
  type CryptoKeyPair = webcrypto.CryptoKeyPair;
  type KeyUsage = webcrypto.KeyUsage;
  type BufferSource = ArrayBufferView | ArrayBuffer;
}

export {};
