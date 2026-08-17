// Trust-on-first-use pinning for the Phala enclave's identity.
//
// Why TOFU and not a real pin: Phala publishes no registry of known-good measurements.
// The expected MRTD/RTMR0-2 are *computed* with dstack-mr from the reproducible dstack
// OS build, and the gateway's compose-hash from its published source — neither of which
// we do yet. So the honest guarantee is narrow and worth stating plainly: we can tell
// you the image CHANGED, never that it was right to begin with.
//
// That shapes the semantics deliberately:
//   - first sight records and reports `first-seen` — never "verified"
//   - a later mismatch reports `changed` with the exact fields that moved
//   - `changed` is NOT a failure. Phala upgrades the gateway legitimately, and hard-
//     failing on every upgrade would train the user to ignore the one that matters.
// The verdict stays where the cryptography is; this only ever adds a visible state.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalDir } from "../../config/paths.ts";

// The fields worth pinning: the image identity (MRTD + boot registers, os-image-hash)
// and the app identity (app-id, compose-hash, key-management root). Deliberately NOT
// instance-id — it changes on every restart of the same image, so pinning it would
// cry wolf constantly and bury a real change.
export interface PhalaPin {
  mrTd?: string;
  rtMr0?: string;
  rtMr1?: string;
  rtMr2?: string;
  appId?: string;
  composeHash?: string;
  osImageHash?: string;
  mrKms?: string;
}

export type PinState = "first-seen" | "unchanged" | "changed";

export interface PinResult {
  state: PinState;
  // Field-level drift, e.g. "composeHash: 73fa4608… → 91bd0c2a…". Empty unless changed.
  changed: string[];
  firstSeenAt?: string;
}

const PIN_VERSION = 1;

function pinPath(): string {
  return join(globalDir(), "phala-enclave-pin.json");
}

function readPin(): { v?: number; firstSeenAt?: string; pin?: PhalaPin } | null {
  try {
    const parsed = JSON.parse(readFileSync(pinPath(), "utf8")) as { v?: number; firstSeenAt?: string; pin?: PhalaPin };
    if (parsed?.v !== PIN_VERSION || !parsed.pin || typeof parsed.pin !== "object") return null;
    return parsed;
  } catch {
    return null; // absent, unreadable, or garbage — treated as first sight
  }
}

function writePin(pin: PhalaPin, firstSeenAt: string): void {
  try {
    mkdirSync(globalDir(), { recursive: true });
    writeFileSync(pinPath(), JSON.stringify({ v: PIN_VERSION, firstSeenAt, pin }, null, 2) + "\n", "utf8");
  } catch {
    // Unwritable home: every run then reports first-seen. Degrading to "no memory" is
    // right — the alternative is inventing an "unchanged" we cannot substantiate.
  }
}

// Compare against the stored pin, recording it on first sight.
//
// `now` is injected rather than read from the clock so tests are deterministic; the
// timestamp is display-only (it never participates in the comparison).
export function checkPin(current: PhalaPin, now: () => string = () => new Date().toISOString()): PinResult {
  const stored = readPin();
  if (!stored?.pin) {
    const firstSeenAt = now();
    writePin(current, firstSeenAt);
    return { state: "first-seen", changed: [], firstSeenAt };
  }

  const changed: string[] = [];
  for (const key of Object.keys(current) as (keyof PhalaPin)[]) {
    const was = stored.pin[key];
    const is = current[key];
    // Only compare fields present on BOTH sides. A field the gateway stopped sending
    // is an absence, not a substitution, and calling it drift would be a false alarm.
    if (was && is && was !== is) changed.push(`${key}: ${was.slice(0, 12)}… → ${is.slice(0, 12)}…`);
  }

  if (changed.length === 0) return { state: "unchanged", changed: [], firstSeenAt: stored.firstSeenAt };

  // Re-pin to the new identity so the change is reported ONCE. Leaving the old pin in
  // place would repeat the same warning every turn until it became wallpaper — and the
  // user has already been shown exactly what moved.
  writePin(current, stored.firstSeenAt ?? now());
  return { state: "changed", changed, firstSeenAt: stored.firstSeenAt };
}
