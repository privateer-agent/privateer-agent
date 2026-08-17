// Handing an unattended run's SPEND AUTHORIZATION down to its subagent children.
//
// THE PROBLEM. A subagent is a fresh headless `pi` subprocess (pi-subagents, spawned
// through bin/privateer-subagent.mjs), so it inherits nothing from its parent except the
// environment and the `-e` moat the wrapper injects. Its gate therefore runs in bypass
// with a fail-closed asker: ordinary writes go through, and every `alwaysAsk` tool — which
// is every billing media tool — is denied, because there is no human on the other end of
// a headless child's stdin. So "one subagent per shot" worked in a terminal, where the
// child's ask relays up to the parent's TUI, and quietly could not work at all in the one
// place it matters most: a routine that fires at 3am to build a film.
//
// WHAT IS HANDED DOWN, AND WHY THAT IS NOT A HOLE. Only the names of billing tools the
// operator already authorized for this run, by naming them when they saved the routine —
// media generation is deliberately absent from the harbor's default allow-list precisely
// so that granting it is a decision someone made. The child gets no more than its parent
// has, and the gate still refuses to let a pre-authorization cover a call that leaves the
// working directory or touches a protected file (see ModeGate.isSpendPreauthorized).
//
// HONOURED ONLY IN A CHILD. `PRIVATEER_CHILD_SPEND` sitting in a developer's shell must
// never turn a TERMINAL into a session that bills without asking, so the child side reads
// it only when pi-subagents has marked this process as a child. A top-level session always
// asks its human, however cheap the call.
//
// CONCURRENCY, AND WHY THE UNION WOULD BE WRONG. The harbor daemon can have two unattended
// runs in flight at once (a scheduled routine and an app-submitted task), and children read
// the environment when they spawn — one process-wide variable, two different grants. Taking
// the union would let run B's child spend on a tool only run A was granted. So the exported
// value is the INTERSECTION of every grant currently in flight: exact when one run holds a
// grant (the overwhelmingly common case), and narrowing — fail-closed, with the gate's
// ordinary denial message — when two overlap. A child denied that way reports it plainly;
// a child over-granted would bill silently.

import { isSubagentChild } from "../remote/subagentRelay.ts";

/** The env var carrying a run's spend grant to its (possibly nested) children. */
export const CHILD_SPEND_ENV = "PRIVATEER_CHILD_SPEND";

// Grants currently in flight, keyed by the run that holds one. Module-level because the
// value it projects is process-wide (the environment) — one registry per daemon.
const active = new Map<string, ReadonlySet<string>>();

function publish(): void {
  if (active.size === 0) {
    delete process.env[CHILD_SPEND_ENV];
    return;
  }
  const sets = [...active.values()];
  const shared = [...sets[0]].filter((tool) => sets.every((s) => s.has(tool)));
  if (shared.length === 0) delete process.env[CHILD_SPEND_ENV];
  else process.env[CHILD_SPEND_ENV] = [...new Set(shared)].sort().join(",");
}

/**
 * Advertise `tools` to children spawned while this run is in flight, and return the
 * release. ALWAYS call the release in a `finally`: a grant that outlives its run would
 * authorize the next one's children, which is the whole thing this is careful about.
 * An empty/absent `tools` registers nothing, so a run with no media grant neither widens
 * nor narrows what a concurrent run advertises.
 */
export function grantChildSpend(runKey: string, tools: Iterable<string> | undefined): () => void {
  const set = new Set([...(tools ?? [])].filter((t) => typeof t === "string" && t.trim() !== ""));
  if (set.size === 0) return () => {};
  active.set(runKey, set);
  publish();
  return () => {
    active.delete(runKey);
    publish();
  };
}

/** Test seam: forget every in-flight grant (and the env var it projects). */
export function resetChildSpend(): void {
  active.clear();
  delete process.env[CHILD_SPEND_ENV];
}

/**
 * The grant this process inherited — empty unless we ARE a subagent child, so a stray
 * env var can never lower a terminal's gate. Parsed defensively: unknown names simply
 * never match a tool, and the gate's own guards bound what a match can authorize.
 */
export function inheritedChildSpend(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  if (!isSubagentChild()) return new Set();
  const raw = env[CHILD_SPEND_ENV];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );
}

/**
 * Is `tool` pre-authorized for this process? False everywhere but a child that was
 * granted it. Shape matches GateController.isSpendPreauthorized's needs.
 */
export function childSpendAllows(tool: string): boolean {
  return inheritedChildSpend().has(tool);
}

/** Does this child hold any spend grant at all — i.e. should billing tools exist here? */
export function childHoldsSpendGrant(): boolean {
  return inheritedChildSpend().size > 0;
}
