// Whether this process may open a cloud relay socket at all.
//
// Distinct from "is remote access on" — that is a decision each surface already
// makes for itself (`/remote-access` in the TUI, a running harbor's syncRelay).
// This is the machine's answer to a prior question: MAY that decision be yes?
//
// Unset means ALLOWED, and that default is what keeps every existing surface
// unchanged: a `privateer harbor` someone started by hand is a harbor they asked
// to be reachable, and the CLI's /remote-access has always been an explicit act.
// Nothing in this repo sets the variable.
//
// The desktop shell is the caller that does. There, remote access is a per-machine
// preference that defaults OFF (a GUI app that auto-starts a harbor would otherwise
// put a socket on the relay for a user who never asked for one), so the shell stamps
// its answer into the harbor child's environment.
//
// Read at CALL time rather than latched at boot, so a harbor that was already
// running when the shell re-spawned it with a different answer honours the new one
// on its next tick instead of the value it happened to start with.
const OFF = new Set(["0", "false", "off", "no"]);

export function relayExposureAllowed(): boolean {
  const v = process.env.PRIVATEER_RELAY_EXPOSURE?.trim().toLowerCase();
  if (!v) return true;
  return !OFF.has(v);
}
