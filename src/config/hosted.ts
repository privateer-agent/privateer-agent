import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalDir } from "./paths.ts";
import { terminalPublicKeyBase64 } from "../crypto/terminalKey.ts";
import { hasCredentials } from "../auth/privateer.ts";

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
 * Is this agent allowed to reach the live web (web_search / web_fetch)?
 *
 * Both tools are served by the account API, so credentials are a hard prerequisite —
 * without them there is nothing to authenticate with and every call would 401.
 *
 * `HARBOR_WEB` is authoritative when set. Hosted agents always set it explicitly, from
 * the per-agent switch in the app (harborOrchestrator/tenants.js → tenantEnv), because
 * a search sends the derived query out of the enclave to our servers and that has to be
 * the user's call. Unset — a daemon on someone's own laptop — defaults to on once
 * signed in: the same account, the same billing, and nothing to disclose beyond what
 * the tool description already says.
 */
export function webEnabled(): boolean {
  const flag = process.env.HARBOR_WEB;
  if (flag === "1") return hasCredentials();
  if (flag === "0") return false;
  return hasCredentials();
}

/**
 * Is this agent allowed to GENERATE media (images, video, speech, music)?
 *
 * Every media call is served by the account API, so credentials are a hard prerequisite.
 * `HARBOR_MEDIA` is authoritative when set. When it is UNSET the default splits by where
 * we run: a hosted tenant fails CLOSED, a daemon on the user's own machine defaults on
 * once signed in. Hosted has to be off-by-default because generation spends real credit
 * and sends the prompt (plus any input image) out of the enclave to a model provider —
 * that is a grant the user makes per agent (tenantEnv sets HARBOR_MEDIA=1), never one a
 * missing env var hands out. (Contrast webEnabled, whose unset-default is on everywhere
 * only because the orchestrator ALWAYS sets HARBOR_WEB in hosted mode; HARBOR_MEDIA is
 * not guaranteed to be set, so the default here must be the safe one.)
 *
 * It is a separate switch from web access because it buys a different thing and costs a
 * different thing. Generation spends real credit — cents for an image, up to a dollar
 * for a video clip — where a search costs a fraction of one, and the prompt (plus any
 * input image) leaves the enclave for a model provider rather than for a search index.
 * A hosted agent that should read the news is not automatically one that should be able
 * to bill the account for a minute of video.
 *
 * Note this gates GENERATION only. `video_compose` is local ffmpeg work on files
 * already on disk — no account, no network, no spend — and stays available regardless,
 * so an agent can still finish assembling media a previous run produced.
 */
export function mediaEnabled(): boolean {
  const flag = process.env.HARBOR_MEDIA;
  if (flag === "1") return hasCredentials();
  if (flag === "0") return false;
  // Unset: hosted tenants fail closed (explicit per-agent grant only); a daemon on
  // the user's own machine defaults on once signed in.
  if (isHosted()) return false;
  return hasCredentials();
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
