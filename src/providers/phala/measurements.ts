// TDX measurement verification for the Phala ACI report — the layer above the quote
// signature check in ../phalaSeal.ts.
//
// The quote proves genuine Intel silicon and binds the E2EE key we seal to. It does
// NOT say which image answered. These are the checks that start to close that gap,
// and they split into two kinds that must never be confused:
//
//   SELF-CONSISTENCY (gates, verified here from the report alone)
//     - the event log replays to the RTMRs the hardware signed
//     - sha256(app_compose) equals the compose-hash the log claims
//     Both are checkable with no outside knowledge, so a failure means the report is
//     malformed or doctored and we refuse it.
//
//   IDENTITY (evidence, NOT a gate)
//     - is this the same image we saw last time?
//     Phala publishes no registry of known-good measurements; expected MRTD/RTMR0-2
//     are computed with dstack-mr from the reproducible dstack OS build. Until we do
//     that, first contact is trust-on-first-use: we can detect that the image CHANGED,
//     never that it is the RIGHT one. Reporting drift as a hard failure would be a
//     false alarm on every legitimate upgrade; reporting first-sight as "verified"
//     would be the overclaim. So it surfaces as its own state and moves no verdict.
//
// Verified against the live gateway 2026-08-17: all four RTMRs replay and the
// compose-hash matches.

import { createHash } from "node:crypto";

// One entry of the dstack event log. `imr` selects the register it extends; `digest`
// is what actually gets hashed in. `event`/`event_payload` are the human-readable
// name and value (app-id, compose-hash, os-image-hash, …).
export interface TdxEvent {
  imr: number;
  digest: string;
  event?: string;
  event_payload?: string;
}

// The app-layer values the IMR3 log names. Every one is a string we can pin.
export interface PhalaAppIdentity {
  appId?: string;
  composeHash?: string;
  osImageHash?: string;
  instanceId?: string;
  mrKms?: string;
  keyProvider?: string;
}

export interface ReplayedRtmrs {
  rtMr0: string;
  rtMr1: string;
  rtMr2: string;
  rtMr3: string;
}

const RTMR_KEYS = ["rtMr0", "rtMr1", "rtMr2", "rtMr3"] as const;

// The event log arrives as a JSON *string* inside evidence (not an array), so it has
// to be parsed before anything can replay it. Lenient: a shape we don't recognise
// yields [] and the caller decides — an absent log is a missing check, not a forgery.
export function parseEventLog(raw: unknown): TdxEvent[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is TdxEvent =>
      !!e && typeof e === "object" && typeof (e as TdxEvent).imr === "number" && typeof (e as TdxEvent).digest === "string",
  );
}

// Replay the hash chain each register accumulates: starting from 48 zero bytes,
// rtmr = SHA384(rtmr ‖ digest) for every event extending that register, in log order.
// Order is load-bearing — the same events in a different sequence give a different
// register, which is exactly what makes the log unforgeable against a signed quote.
export function replayRtmrs(events: TdxEvent[]): ReplayedRtmrs {
  const out = {} as Record<(typeof RTMR_KEYS)[number], string>;
  RTMR_KEYS.forEach((key, imr) => {
    let acc = Buffer.alloc(48);
    for (const ev of events) {
      if (ev.imr !== imr) continue;
      let digest: Buffer;
      try {
        digest = Buffer.from(ev.digest, "hex");
      } catch {
        continue;
      }
      acc = createHash("sha384").update(Buffer.concat([acc, digest])).digest();
    }
    out[key] = acc.toString("hex");
  });
  return out;
}

// The named app-layer values out of the IMR3 events.
export function appIdentityFrom(events: TdxEvent[]): PhalaAppIdentity {
  const byName = new Map<string, string>();
  for (const ev of events) {
    if (ev.imr === 3 && ev.event && typeof ev.event_payload === "string" && ev.event_payload) {
      byName.set(ev.event, ev.event_payload);
    }
  }
  return {
    appId: byName.get("app-id"),
    composeHash: byName.get("compose-hash"),
    osImageHash: byName.get("os-image-hash"),
    instanceId: byName.get("instance-id"),
    mrKms: byName.get("mr-kms"),
    keyProvider: byName.get("key-provider"),
  };
}

// sha256 over the app-compose document exactly as shipped. Hashing a re-serialized
// object would silently "fix" any difference in key order or whitespace and match a
// document that isn't the measured one, so a string is hashed verbatim.
export function computeComposeHash(appCompose: unknown): string | undefined {
  if (typeof appCompose !== "string" || !appCompose) return undefined;
  return createHash("sha256").update(Buffer.from(appCompose, "utf8")).digest("hex");
}

export interface ConsistencyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

// The self-consistency gates. `skipped` (no material to check) is reported as its own
// outcome rather than silently passing — a check we did not run must never read as a
// check that succeeded.
export function checkReportConsistency(args: {
  events: TdxEvent[];
  quoted: ReplayedRtmrs;
  appCompose: unknown;
  identity: PhalaAppIdentity;
}): { checks: ConsistencyCheck[]; ok: boolean; skipped: string[] } {
  const checks: ConsistencyCheck[] = [];
  const skipped: string[] = [];

  if (args.events.length === 0) {
    skipped.push("rtmr-replay");
  } else {
    const replayed = replayRtmrs(args.events);
    for (const key of RTMR_KEYS) {
      const ok = replayed[key] === args.quoted[key];
      checks.push({
        name: `rtmr-replay:${key}`,
        ok,
        detail: ok ? undefined : `replayed ${replayed[key].slice(0, 16)}… but the quote signed ${args.quoted[key].slice(0, 16)}…`,
      });
    }
  }

  const computed = computeComposeHash(args.appCompose);
  if (!computed || !args.identity.composeHash) {
    skipped.push("compose-hash");
  } else {
    const ok = computed === args.identity.composeHash;
    checks.push({
      name: "compose-hash",
      ok,
      detail: ok ? undefined : `sha256(app_compose)=${computed.slice(0, 16)}… but the log attests ${args.identity.composeHash.slice(0, 16)}…`,
    });
  }

  return { checks, ok: checks.every((c) => c.ok), skipped };
}
