import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalDir } from "./paths.ts";
import { terminalPublicKeyBase64 } from "../crypto/terminalKey.ts";

// Harbor hosted mode.
//
// When true, this harbor is running inside Privateer's confidential-VM fleet
// (the host orchestrator sets HARBOR_HOSTED=1), not on a user's own machine.
// Hosted harbors run on-demand: they report their next routine fire time to the
// server and idle-suspend when there's no work, so the server can wake them
// again in time. A harbor on a user's laptop leaves this off and keeps running
// its own cron continuously.
//
// Read via process.env at call time, mirroring PRIVATEER_HOME / PRIVATEER_SERVER_URL.
export function isHosted(): boolean {
  return process.env.HARBOR_HOSTED === "1";
}

/**
 * Publish this harbor's relay identity key so the Harbor host can attest it.
 *
 * ATTESTATION CONTRACT (host side: treeview `server/services/harborOrchestrator/`):
 * the orchestrator mints the SEV-SNP report on the CVM host — configfs-tsm is a
 * privileged kernel interface a rootless tenant deliberately cannot reach — and binds
 * `report_data[0:32] = sha256(DER-SPKI(terminalPub))`. To do that it needs OUR public
 * key, so we drop it in `$PRIVATEER_HOME` (bind-mounted from host tmpfs) as the mirror
 * of the `routines/relay-id` file the host seeds for us.
 *
 * It must be the key the app ACTUALLY drives over the relay — the same value we send
 * in sendContext({ terminalPub }) — otherwise the app's fail-closed check reports a
 * key mismatch. Base64 of the raw 32 X25519 bytes; the host wraps it in the SPKI DER
 * prefix itself. Minting happens on first call, which is fine: this runs at boot,
 * before the relay registers.
 *
 * Hosted-only and best-effort: on a user's own machine this is a no-op, and a write
 * failure must never take the harbor down — attestation simply fail-closes host-side
 * with HARBOR_ATTEST_NO_KEY rather than reporting a false "attested".
 */
export function publishRelayPub(): void {
  if (!isHosted()) return;
  try {
    writeFileSync(join(globalDir(), "relay-pub"), terminalPublicKeyBase64(), { mode: 0o600 });
  } catch (err) {
    console.error(
      `[harbor] could not publish relay-pub — enclave attestation will fail closed: ${String(err)}`,
    );
  }
}
