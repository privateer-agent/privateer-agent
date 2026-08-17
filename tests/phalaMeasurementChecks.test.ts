import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parseEventLog,
  replayRtmrs,
  appIdentityFrom,
  computeComposeHash,
  checkReportConsistency,
  type TdxEvent,
} from "../src/providers/phala/measurements.ts";

// These are the checks that can be made from the report ALONE, so they are gates. The
// property each test defends is that a report which fails one is refused — and, just as
// important, that a check we could not run is reported as skipped rather than passed.

const D = (n: number) => Buffer.alloc(48, n).toString("hex");

/** The hash chain the hardware performs: rtmr = SHA384(rtmr ‖ digest). */
function chain(digests: string[]): string {
  let acc = Buffer.alloc(48);
  for (const d of digests) acc = createHash("sha384").update(Buffer.concat([acc, Buffer.from(d, "hex")])).digest();
  return acc.toString("hex");
}

const EVENTS: TdxEvent[] = [
  { imr: 0, digest: D(1) },
  { imr: 1, digest: D(2) },
  { imr: 2, digest: D(3) },
  { imr: 3, digest: D(4), event: "app-id", event_payload: "fdb7a14e" },
  { imr: 3, digest: D(5), event: "compose-hash", event_payload: "73fa4608" },
  { imr: 3, digest: D(6), event: "os-image-hash", event_payload: "bd369a8c" },
  { imr: 3, digest: D(7), event: "instance-id", event_payload: "15e847e0" },
  { imr: 3, digest: D(8), event: "mr-kms", event_payload: "692afc6d" },
];

const QUOTED = {
  rtMr0: chain([D(1)]),
  rtMr1: chain([D(2)]),
  rtMr2: chain([D(3)]),
  rtMr3: chain([D(4), D(5), D(6), D(7), D(8)]),
};

const COMPOSE = '{"docker_compose_file":"services:\\n  gateway:\\n"}';
const COMPOSE_HASH = createHash("sha256").update(Buffer.from(COMPOSE, "utf8")).digest("hex");

function identityWithRealHash() {
  return { ...appIdentityFrom(EVENTS), composeHash: COMPOSE_HASH };
}

test("the event log arrives as a JSON string and parses to events", () => {
  // The live gateway ships evidence.event_log as a string, not an array — handing the
  // raw value to a replay that expected an array silently yields zero events, which
  // would look like a clean pass.
  const parsed = parseEventLog(JSON.stringify(EVENTS));
  assert.equal(parsed.length, EVENTS.length);
  assert.equal(parsed[3].event, "app-id");
});

test("malformed or absent logs parse to nothing rather than throwing", () => {
  assert.deepEqual(parseEventLog("not json"), []);
  assert.deepEqual(parseEventLog(undefined), []);
  assert.deepEqual(parseEventLog({ imr: 0 }), []);
  // Entries missing the fields the replay needs are dropped, not guessed at.
  assert.deepEqual(parseEventLog([{ imr: 0 }, { digest: "aa" }]), []);
});

test("replay reproduces each register from its own events", () => {
  assert.deepEqual(replayRtmrs(EVENTS), QUOTED);
});

test("event ORDER changes the result", () => {
  // Order is what makes the log unforgeable against a signed quote: an attacker who
  // could reorder events without changing the register could rewrite history.
  const swapped = [...EVENTS];
  [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  assert.notEqual(replayRtmrs(swapped).rtMr3, QUOTED.rtMr3);
});

test("a tampered event log fails the replay gate", () => {
  const tampered = EVENTS.map((e) => (e.event === "compose-hash" ? { ...e, digest: D(99) } : e));
  const res = checkReportConsistency({
    events: tampered,
    quoted: QUOTED,
    appCompose: COMPOSE,
    identity: identityWithRealHash(),
  });
  assert.equal(res.ok, false);
  assert.ok(res.checks.some((c) => c.name === "rtmr-replay:rtMr3" && !c.ok));
});

test("a substituted app_compose fails the compose-hash gate", () => {
  const res = checkReportConsistency({
    events: EVENTS,
    quoted: QUOTED,
    appCompose: '{"docker_compose_file":"services:\\n  evil:\\n"}',
    identity: identityWithRealHash(),
  });
  assert.equal(res.ok, false);
  assert.ok(res.checks.some((c) => c.name === "compose-hash" && !c.ok));
});

test("a consistent report passes every gate", () => {
  const res = checkReportConsistency({
    events: EVENTS,
    quoted: QUOTED,
    appCompose: COMPOSE,
    identity: identityWithRealHash(),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.skipped, []);
});

test("missing material is SKIPPED, never silently passed", () => {
  // The failure mode this guards: no event log → nothing to compare → `ok` is
  // vacuously true. It must be visible that the check did not run.
  const res = checkReportConsistency({
    events: [],
    quoted: QUOTED,
    appCompose: undefined,
    identity: {},
  });
  assert.deepEqual(res.skipped.sort(), ["compose-hash", "rtmr-replay"]);
  assert.equal(res.checks.length, 0);
});

test("compose hash is taken over the shipped bytes verbatim", () => {
  // Re-serializing an object would normalize key order and whitespace and could match
  // a document that is not the measured one.
  assert.equal(computeComposeHash(COMPOSE), COMPOSE_HASH);
  assert.equal(computeComposeHash({ a: 1 }), undefined);
  assert.equal(computeComposeHash(""), undefined);
});

test("app identity is read from the IMR3 events only", () => {
  const id = appIdentityFrom([...EVENTS, { imr: 0, digest: D(9), event: "app-id", event_payload: "spoofed" }]);
  assert.equal(id.appId, "fdb7a14e");
  assert.equal(id.osImageHash, "bd369a8c");
  assert.equal(id.mrKms, "692afc6d");
});
