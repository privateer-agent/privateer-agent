// "Did this process already build its own permission gate in code?" — a process-level
// marker, set by every non-TUI entry that passes makePermissionGate() as an inline
// extension factory, and read by the shipped gate extension so it doesn't install a
// SECOND one on top.
//
// The problem it solves: ~/.privateer/agent/extensions holds discovery shims for the
// interactive TUI's extensions (installed by bin/privateer-launch.mjs). Pi discovers
// them into every session built against that agentDir, and merges them with inline
// factories — discovered FIRST, factories appended after (core/resource-loader.js).
// extensions/privateer-gate.ts is one of those shims and it installs its own gate,
// wired to the module-level RemoteBridge that only `/remote-access` ever attaches a
// relay to. In a harbor / channels process that bridge is permanently unattached, so
// the discovered copy believes every turn is LOCAL — and its cwd is process.cwd()
// (the daemon's, not the session's) with a module-level allowlist shared across
// concurrent sessions. What that costs depends on whether `session_start` fired,
// which in Pi only happens if something calls bindExtensions():
//   • a live task spawn DOES bind (for the relayed select/confirm), so the copy sees
//     ctx.mode "print", flips itself to bypass, and only intervenes on dangerous
//     shell / destructive / secret-exfil actions — where it asks through ctx.ui,
//     which the spawn relays to the app as a SECOND dialog on top of the session
//     gate's own approval for the same call;
//   • the harbor's headless runs (routines, workflows, submitted tasks) and the
//     channels runner never bind, so session_start never fires, the copy stays in
//     "default" mode with no UI, and defaultLocalAsk fails closed — DENYING every
//     gated tool before the session's real approver is ever consulted.
// Neither is what these entries want: they each wire a gate that knows their cwd and
// their approver.
//
// INVARIANT: set this ONLY from a path that installs makePermissionGate() itself.
// Marking a process that doesn't would leave its sessions ungated.
//
// `privateer acp` solves the same collision differently — `noExtensions: true`, so
// nothing is discovered at all (see src/acp/run.ts) — and needs no marker.
//
// An env var rather than a module singleton on purpose: discovered extensions load
// through jiti with its module cache off, so they may hold a SEPARATE copy of our
// modules. process.env is the one piece of state both copies are guaranteed to share.
// It is inherited by child processes, which is why the shim pairs this check with
// isSubagentChild() — a subagent child loads the moat explicitly (`-e`) and must keep
// its own gate. See bin/privateer-subagent.mjs.
//
// IMPORT-SAFETY: no Pi imports, no node builtins — safe to load from anywhere.

const ENV = "PRIVATEER_INLINE_MOAT";

/** Called once by an entry that loads the moat as an in-code factory. Idempotent. */
export function markInlineMoat(): void {
  process.env[ENV] = "1";
}

/** True in a process whose sessions already carry their own in-code permission gate. */
export function inlineMoat(): boolean {
  return process.env[ENV] === "1";
}

/**
 * Should a DISCOVERED gate extension install its permission gate in this process?
 *
 * No when the session already has one from an inline factory — EXCEPT in a subagent
 * child, which inherits the parent's environment but loads this extension explicitly
 * (`-e`, bin/privateer-subagent.mjs) as its ONLY moat. Getting that carve-out wrong
 * runs a harbor task's children with no gate at all, so it is a parameter rather than
 * an env read here: the caller passes isSubagentChild() and the matrix is testable.
 */
export function discoveredGateApplies(isSubagentChild: boolean): boolean {
  return !inlineMoat() || isSubagentChild;
}
