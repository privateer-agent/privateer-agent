import { test } from "node:test";
import assert from "node:assert/strict";
import type { Report } from "@phala/dcap-qvl";
import { extractQuoteMeasurements } from "../src/providers/phalaSeal.ts";

// The TDX launch measurements are read off a quote whose signature has ALREADY been
// verified, so the risk these tests pin down is not forgery — it's a half-populated
// report being rendered as if it were full evidence. RTMR3 is the register that
// carries the app layer (compose hash / app id), so a set missing exactly that one
// would look like proof while omitting the part that identifies the workload.

const bytes = (fill: number, len = 48) => new Uint8Array(len).fill(fill);

function td10(over: Record<string, Uint8Array | undefined> = {}) {
  return {
    mrTd: bytes(0x11),
    rtMr0: bytes(0x22),
    rtMr1: bytes(0x33),
    rtMr2: bytes(0x44),
    rtMr3: bytes(0x55),
    ...over,
  };
}

/** A duck-typed Report — extractQuoteMeasurements only ever calls asTd10/asTd15. */
function report(kind: "td10" | "td15" | "sgx", over?: Record<string, Uint8Array | undefined>): Report {
  const td = td10(over);
  return {
    asTd10: () => (kind === "td10" ? td : null),
    asTd15: () => (kind === "td15" ? { base: td } : null),
  } as unknown as Report;
}

test("reads all five measurements off a TD1.0 quote", () => {
  const m = extractQuoteMeasurements(report("td10"));
  assert.equal(m?.mrTd, "11".repeat(48));
  assert.equal(m?.rtMr0, "22".repeat(48));
  assert.equal(m?.rtMr1, "33".repeat(48));
  assert.equal(m?.rtMr2, "44".repeat(48));
  assert.equal(m?.rtMr3, "55".repeat(48));
});

test("reads through the base report of a TD1.5 quote", () => {
  // asTd10() returns null for a td15 report, so the fallback to .base is load-bearing
  // — without it every TD1.5 enclave would silently report no measurements at all.
  const m = extractQuoteMeasurements(report("td15"));
  assert.equal(m?.mrTd, "11".repeat(48));
  assert.equal(m?.rtMr3, "55".repeat(48));
});

test("a missing register yields NO measurements, not a partial set", () => {
  assert.equal(extractQuoteMeasurements(report("td10", { rtMr3: undefined })), undefined);
  assert.equal(extractQuoteMeasurements(report("td10", { mrTd: undefined })), undefined);
});

test("an empty register counts as missing", () => {
  // A zero-length buffer would hex-encode to "" and render as a blank line under the
  // measurement heading — indistinguishable from a value at a glance.
  assert.equal(extractQuoteMeasurements(report("td10", { rtMr1: new Uint8Array(0) })), undefined);
});

test("a non-TD (SGX) quote reports no measurements", () => {
  assert.equal(extractQuoteMeasurements(report("sgx")), undefined);
});
