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
 *  since it belongs to the signed-in account. */
export function clearAccountSignKey(): void {
  try { rmSync(trustPath(), { force: true }); } catch { /* nothing to remove */ }
  try { rmSync(tsPath(), { force: true }); } catch { /* nothing to remove */ }
}

// ── Anti-replay watermark for signed channel-saves ──────────────────────────────
// The highest `ts` we've applied. A save with a ts BELOW this is a replay/rollback of
// an older signed envelope and is refused; at-or-above is accepted (an idempotent
// replay of the latest is harmless, and this tolerates two saves in the same ms).
// Persisted so the watermark survives a daemon restart.
function tsPath(): string {
  return join(globalDir(), "channels-sig.json");
}

export function loadLastChannelTs(): number {
  try {
    const parsed = JSON.parse(readFileSync(tsPath(), "utf8")) as { lastTs?: number };
    return typeof parsed?.lastTs === "number" ? parsed.lastTs : 0;
  } catch {
    return 0;
  }
}

export function saveLastChannelTs(ts: number): void {
  try {
    writeFileSync(tsPath(), JSON.stringify({ lastTs: ts }), { mode: 0o600 });
  } catch {
    /* best effort */
  }
}
