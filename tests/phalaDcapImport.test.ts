import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDcapVerify } from "../src/providers/phalaSeal.ts";

// The released bundle wraps CommonJS @phala/dcap-qvl as an ESM chunk whose only export
// is `default`. A destructured named import came back undefined there and broke every
// Phala attestation with "getCollateralAndVerify is not a function", while tsx (and so
// every other test) resolved the named export fine. Hold both module shapes.

const fn = async () => ({}) as never;

test("named-export shape (tsx / Node CJS interop)", () => {
  assert.equal(resolveDcapVerify({ getCollateralAndVerify: fn }), fn);
});

test("default-only shape (bundled chunk)", () => {
  assert.equal(resolveDcapVerify({ default: { getCollateralAndVerify: fn } }), fn);
});

test("the real package resolves to a function", async () => {
  assert.equal(typeof resolveDcapVerify(await import("@phala/dcap-qvl")), "function");
});

test("neither shape throws a named error, not 'is not a function'", () => {
  assert.throws(() => resolveDcapVerify({ default: {} }), /did not export getCollateralAndVerify/);
});
