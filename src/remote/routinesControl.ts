/**
 * Routine management for the app.
 *
 * A UI-agnostic wrapper over the routines store so the app (over the relay) can
 * see the harbor's saved routines and create / edit / delete / pause / run them —
 * the sibling of extensionsControl.ts and skillsControl.ts, but for scheduled
 * tasks rather than Pi packages/skills.
 *
 * Unlike those two, routines are owned by the HARBOR (not an interactive Pi
 * session): they live in routines.json (see routines/store.ts) and fire from the
 * resident scheduler. So this control is wired into the harbor's own relay
 * connection (the "Privateer Routines" terminal), not the REPL/TUI. Running a
 * routine now is the one action that needs the harbor itself, so it's injected as
 * `runNow` rather than reaching back into the store.
 *
 * Framework-agnostic: nothing here imports React or the relay. The caller owns the
 * frame plumbing and the run seam.
 */
import {
  loadRoutines,
  upsertRoutine,
  removeRoutine,
  findRoutine,
} from "../routines/store.ts";
import {
  DELIVERY_CHANNELS,
  webhookName,
  newRoutineId,
  type Routine,
} from "../routines/schema.ts";
import { triggerError, computeNextRun } from "../routines/trigger.ts";

// One routine as surfaced to the app. This is the full Routine shape (the user's
// own config shown back to the user's own app), so an edit can round-trip every
// field. NON-secret by nature — the prompt/cwd/model are what the user authored.
export interface RemoteRoutine {
  id: string;
  name: string;
  cron?: string;
  at?: string;
  prompt: string;
  cwd: string;
  model?: string;
  delivery: string[];
  tools?: string[];
  enabled: boolean;
  lastRun?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
  nextRun?: string;
}

// An app-submitted create/edit. `id` present → edit that routine (bookkeeping
// fields are preserved); absent → create a new one. Everything else mirrors the
// create_routine tool's parameters.
export interface RoutineDraft {
  id?: string;
  name?: string;
  cron?: string;
  at?: string;
  prompt?: string;
  cwd?: string;
  model?: string;
  delivery?: string[];
  tools?: string[];
}

export interface RoutinesControl {
  // All saved routines (enabled + paused), most-recently-scheduled first.
  list(): RemoteRoutine[];
  // Create (no id) or edit (id) a routine. Validates the trigger + delivery and
  // schedules nextRun. On an edit, the existing run bookkeeping is preserved.
  save(draft: RoutineDraft): { ok: boolean; message?: string };
  // Remove a routine by id or name. ok:false when nothing matched.
  remove(idOrName: string): { ok: boolean; message?: string };
  // Pause/resume a routine. Resuming reschedules nextRun; pausing clears it.
  setEnabled(idOrName: string, enabled: boolean): { ok: boolean; message?: string };
  // Run a routine now (fire-and-forget on the harbor). ok:false when not found.
  run(idOrName: string): { ok: boolean; message?: string };
}

const KNOWN_CHANNELS = new Set<string>(DELIVERY_CHANNELS);

function cleanStrList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => String(x ?? "").trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

// Validate a delivery list: each entry is a known channel or "webhook:<name>".
// (Webhook existence is checked against config by an injected `webhookExists`, so
// the routine can't silently reference an undeclared endpoint.)
function deliveryError(delivery: string[], webhookExists: (name: string) => boolean): string | null {
  for (const entry of delivery) {
    const hook = webhookName(entry);
    if (hook === null) {
      if (!KNOWN_CHANNELS.has(entry)) return `unknown delivery channel "${entry}"`;
    } else if (!webhookExists(hook)) {
      return `webhook "${hook}" is not configured on this machine`;
    }
  }
  return null;
}

function toRemote(r: Routine): RemoteRoutine {
  return {
    id: r.id,
    name: r.name,
    cron: r.cron,
    at: r.at,
    prompt: r.prompt,
    cwd: r.cwd,
    model: r.model,
    delivery: r.delivery,
    tools: r.tools,
    enabled: r.enabled,
    lastRun: r.lastRun,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
    nextRun: r.nextRun,
  };
}

export function makeRoutinesControl(opts: {
  // Working directory for a new routine when the draft omits `cwd` (the harbor's).
  defaultCwd: () => string;
  // Is a webhook name declared in config? Guards "webhook:<name>" delivery entries.
  webhookExists?: (name: string) => boolean;
  // Fire a routine now — injected by the harbor (its runRoutine). Absent → run is
  // reported unavailable rather than silently dropped.
  runNow?: (routine: Routine) => void;
}): RoutinesControl {
  const webhookExists = opts.webhookExists ?? (() => false);

  return {
    list(): RemoteRoutine[] {
      // Order by soonest next run, then paused ones (no nextRun) last — a stable,
      // useful order for the app without it having to sort.
      return loadRoutines()
        .map(toRemote)
        .sort((a, b) => {
          const ta = a.nextRun ? Date.parse(a.nextRun) : Infinity;
          const tb = b.nextRun ? Date.parse(b.nextRun) : Infinity;
          return ta - tb;
        });
    },

    save(draft: RoutineDraft): { ok: boolean; message?: string } {
      const name = (draft?.name ?? "").trim();
      const prompt = (draft?.prompt ?? "").trim();
      const cron = draft?.cron?.trim() || undefined;
      const at = draft?.at?.trim() || undefined;
      if (!name) return { ok: false, message: "A name is required." };
      if (!prompt) return { ok: false, message: "A prompt is required." };

      const trigErr = triggerError({ cron, at });
      if (trigErr) return { ok: false, message: trigErr };

      const delivery = cleanStrList(draft?.delivery) ?? ["file"];
      const delErr = deliveryError(delivery, webhookExists);
      if (delErr) return { ok: false, message: delErr };

      const existing = draft?.id ? findRoutine(loadRoutines(), draft.id) : undefined;
      // A rename must not collide with a *different* routine's name.
      const clash = loadRoutines().find((r) => r.name.toLowerCase() === name.toLowerCase() && r.id !== existing?.id);
      if (clash) return { ok: false, message: `A routine named "${name}" already exists.` };

      const cwd = (draft?.cwd ?? "").trim() || existing?.cwd || opts.defaultCwd();
      const model = (draft?.model ?? "").trim() || undefined;
      const tools = cleanStrList(draft?.tools);
      const nextRun = computeNextRun({ cron, at })?.toISOString();

      const routine: Routine = {
        // Preserve id + run bookkeeping on edit; mint a fresh id on create.
        id: existing?.id ?? newRoutineId(),
        name,
        cron,
        at,
        prompt,
        cwd,
        model,
        delivery: delivery as Routine["delivery"],
        tools,
        // Keep the enabled state on edit; new routines start enabled.
        enabled: existing?.enabled ?? true,
        lastRun: existing?.lastRun,
        lastStatus: existing?.lastStatus,
        lastError: existing?.lastError,
        nextRun,
      };
      upsertRoutine(routine);
      return { ok: true, message: existing ? `Updated "${name}".` : `Created "${name}".` };
    },

    remove(idOrName: string): { ok: boolean; message?: string } {
      const removed = removeRoutine((idOrName ?? "").trim());
      return removed ? { ok: true, message: `Removed "${removed.name}".` } : { ok: false, message: "Not found." };
    },

    setEnabled(idOrName: string, enabled: boolean): { ok: boolean; message?: string } {
      const r = findRoutine(loadRoutines(), (idOrName ?? "").trim());
      if (!r) return { ok: false, message: "Not found." };
      const nextRun = enabled ? computeNextRun(r)?.toISOString() : undefined;
      upsertRoutine({ ...r, enabled, nextRun });
      return { ok: true, message: `${enabled ? "Resumed" : "Paused"} "${r.name}".` };
    },

    run(idOrName: string): { ok: boolean; message?: string } {
      const r = findRoutine(loadRoutines(), (idOrName ?? "").trim());
      if (!r) return { ok: false, message: "Not found." };
      if (!opts.runNow) return { ok: false, message: "The scheduler can't run this right now." };
      opts.runNow(r);
      return { ok: true, message: `Running "${r.name}" now.` };
    },
  };
}
