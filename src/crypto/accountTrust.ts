/**
 * Pinned account signing key — TERMINAL side (Phase 4 TOFU, mirror of the app's
 * terminalTrustService).
 *
 * At link time the app hands this terminal the account's Ed25519 signing public key
 * (bound into the device-code grant, delivered in the /auth/device/token response). We
 * pin it here. Every app channel-save is then verified against this key
 * (accountVerify.ts): only the account master-key holder can sign, so a hostile relay
 * can neither forge a channel config nor inject an admin.
 *
 * The pinned value is a PUBLIC key, but its INTEGRITY is the security property — a
 * local attacker who could swap it would defeat verification — so it's written 0600
 * beside the other machine trust roots (terminal-key.json, config.json). A server
 * malicious at the single link moment could substitute it (the accepted TOFU limit,
 * symmetric with the app-side pin); a server that turns malicious later cannot.
 */

import { readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { globalDir } from "../config/paths.ts";

interface AccountTrustFile {
  v: 1;
  accountSignPub: string; // base64 Ed25519 public key
}

function trustPath(): string {
  return join(globalDir(), "account-trust.json");
}

/** Pin the account signing public key (idempotent). A blank/absent value is ignored
 *  (an older app or a locked vault simply doesn't establish the pin). */
export function pinAccountSignKey(pub: string | undefined | null): void {
  const value = (pub ?? "").trim();
  if (!value) return;
  try {
    const file: AccountTrustFile = { v: 1, accountSignPub: value };
    writeFileSync(trustPath(), JSON.stringify(file), { mode: 0o600 });
    try { chmodSync(trustPath(), 0o600); } catch { /* non-POSIX FS */ }
  } catch {
    /* best effort — a missing pin just means channel-saves fail-closed until re-link */
  }
}

/** The pinned account signing public key (base64), or undefined if none is pinned. */
export function loadAccountSignKey(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(trustPath(), "utf8")) as AccountTrustFile;
    return parsed?.v === 1 && typeof parsed.accountSignPub === "string" ? parsed.accountSignPub : undefined;
  } catch {
    return undefined;
  }
}

/** Drop the pin — called when local credentials are cleared (logout / session revoke),
 *  since it belongs to the signed-in account.
 *
 *  We deliberately do NOT clear the anti-replay watermark (control-sig.json) here.
 *  Resetting it to 0 on logout would let a hostile relay replay a previously-captured,
 *  validly-signed channel-save after a re-link (its ts > 0 ≥ 0), rolling config back to
 *  an earlier account-authored state — e.g. re-adding a removed admin (M1). The
 *  watermark is safe to persist across a re-link: it's monotonic wall-clock ms, and a
 *  DIFFERENT account that links later gets a different signing key, so its saves are
 *  gated by signature (not by ts) and its own ts values only ever move forward. */
export function clearAccountSignKey(): void {
  try { rmSync(trustPath(), { force: true }); } catch { /* nothing to remove */ }
}

// ── Anti-replay watermark for signed control frames (per terminal) ───────────────
// The highest `ts` we've applied, keyed by termId. A signed control frame (channel
// save, routine save/run, extension add, skill create, …) whose ts is BELOW the
// watermark for its terminal is a replay/rollback of an older signed envelope and is
// refused; at-or-above is accepted (an idempotent replay of the latest is harmless).
//
// Keyed by termId — NOT global — so the always-on daemon (stable routines-… id) and
// each interactive terminal (its own id) don't cross-reject each other's frames when
// the app drives them near-simultaneously with independent ts streams. Each signed
// frame binds its termId (see accountVerify.controlMessage), so a per-terminal
// watermark is the matching granularity. Persisted so it survives a daemon restart;
// deliberately NOT cleared on logout (see clearAccountSignKey — M1).
function tsPath(): string {
  return join(globalDir(), "control-sig.json");
}

interface ControlSigFile {
  v: 1;
  byTerm: Record<string, number>;
}

function loadControlSig(): ControlSigFile {
  try {
    const parsed = JSON.parse(readFileSync(tsPath(), "utf8")) as ControlSigFile;
    if (parsed?.v === 1 && parsed.byTerm && typeof parsed.byTerm === "object") return parsed;
  } catch {
    /* missing/malformed → fresh */
  }
  return { v: 1, byTerm: {} };
}

export function loadLastControlTs(termId: string): number {
  const ts = loadControlSig().byTerm[termId];
  return typeof ts === "number" ? ts : 0;
}

export function saveLastControlTs(termId: string, ts: number): void {
  try {
    const file = loadControlSig();
    file.byTerm[termId] = Math.max(file.byTerm[termId] ?? 0, ts);
    writeFileSync(tsPath(), JSON.stringify(file), { mode: 0o600 });
  } catch {
    /* best effort */
  }
}
