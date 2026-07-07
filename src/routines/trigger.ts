import { nextRun as cronNext, cronError } from "./cron.ts";
import { isRecurring, type Routine } from "./schema.ts";

// A routine's trigger: a recurring `cron` expression or a one-off `at` datetime.
type Trigger = Pick<Routine, "cron" | "at">;

// Validate the trigger, returning an error message or null. Enforces "exactly one"
// and that the chosen form parses.
export function triggerError(t: Trigger): string | null {
  const hasCron = Boolean(t.cron);
  const hasAt = Boolean(t.at);
  if (hasCron === hasAt) return "set exactly one of `cron` (recurring) or `at` (one-off)";
  if (hasCron) return cronError(t.cron!);
  return Number.isNaN(Date.parse(t.at!)) ? `invalid datetime "${t.at}"` : null;
}

// The fire time to store as `nextRun`. For cron: the next match strictly after
// `from`. For a one-off: the fixed `at` time as-is (even if already past, so a
// missed one-off still fires once when the daemon comes back). Null if unparseable.
export function computeNextRun(t: Trigger, from: Date = new Date()): Date | null {
  if (t.cron) return cronNext(t.cron, from);
  if (t.at) {
    const d = new Date(t.at);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// After a run, what to persist. Recurring routines reschedule; one-offs disable
// themselves (they've now fired).
export function advanceAfterRun(routine: Routine, from: Date = new Date()): Partial<Routine> {
  if (isRecurring(routine)) return { nextRun: computeNextRun(routine, from)?.toISOString() };
  return { enabled: false, nextRun: undefined };
}

// Short human description of when a routine fires, for /routine listings.
export function describeTrigger(t: Trigger): string {
  if (t.cron) return t.cron;
  if (t.at) return `once @ ${new Date(t.at).toLocaleString()}`;
  return "(no trigger)";
}
