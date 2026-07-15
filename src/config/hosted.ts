// Harbor hosted mode.
//
// When true, this daemon is running inside Privateer's confidential-VM fleet
// (the host orchestrator sets HARBOR_HOSTED=1), not on a user's own machine.
// Hosted daemons run on-demand: they report their next routine fire time to the
// server and idle-suspend when there's no work, so the server can wake them
// again in time. A daemon on a user's laptop leaves this off and keeps running
// its own cron continuously.
//
// Read via process.env at call time, mirroring PRIVATEER_HOME / PRIVATEER_SERVER_URL.
export function isHosted(): boolean {
  return process.env.HARBOR_HOSTED === "1";
}
