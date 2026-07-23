/**
 * Workflow management for the app (§8.3).
 *
 * The sibling of routinesControl.ts / channelsControl.ts, for declarative workflow
 * graphs. UI-agnostic: nothing here imports React or the relay — the caller (the
 * harbor) owns the frame plumbing, the signed-frame gate (authorizeControl), and the
 * run seam. Like routines, workflows are owned by the HARBOR (they run on its resident
 * scheduler / on-demand), so this control is wired into the harbor's own relay.
 *
 * A workflow file is an EXECUTABLE artifact (it can carry `script` steps), so the
 * harbor MUST verify the account signature on every mutating frame (workflows_save /
 * remove / run) via guardControl BEFORE calling save/remove/run here — a forged save
 * would plant a script step, a forged run would execute one. `list`/`get` are read-only.
 *
 * Scheduling is NOT here: a workflow is triggered by a routines.json entry naming it
 * (§8.3), so enabled/cron/bookkeeping live in the routines layer. This control only
 * creates/edits/removes the graph and runs one on demand.
 */
import {
  loadWorkflows,
  loadWorkflow,
  findWorkflow,
  saveWorkflow,
  removeWorkflow,
} from "../workflows/store.ts";
import { Workflow, validateWorkflow, newWorkflowId } from "../workflows/schema.ts";

// A compact summary for the app's list screen — cheap to render, no full graph. The
// editor fetches the whole Workflow separately via `get`.
export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  entryPoint: string;
  // Counts across the flat graph, so the card can show "5 steps · 2 gates" at a glance.
  stepCount: number;
  gateCount: number;
  scriptCount: number;
}

export interface WorkflowsControl {
  // All saved workflows as summaries, sorted by name.
  list(): WorkflowSummary[];
  // The full graph for one workflow (the app's editor), or undefined if absent.
  get(idOrName: string): Workflow | undefined;
  // Create (no workflow.id) or overwrite (existing id) a workflow. Validates the strict
  // schema AND the route graph; rejects a name that collides with a different workflow.
  save(draft: unknown): { ok: boolean; message?: string; id?: string };
  // Remove a workflow by id or name. ok:false when nothing matched.
  remove(idOrName: string): { ok: boolean; message?: string };
  // Run a workflow now (fire-and-forget on the harbor). ok:false when not found or the
  // runner isn't wired.
  run(idOrName: string): { ok: boolean; message?: string };
}

function summarize(wf: Workflow): WorkflowSummary {
  return {
    id: wf.workflow.id,
    name: wf.workflow.name,
    description: wf.workflow.description,
    entryPoint: wf.workflow.entry_point,
    stepCount: wf.steps.length + wf.parallel.length + wf.for_each.length,
    gateCount: wf.steps.filter((s) => s.type === "human_gate").length,
    scriptCount: wf.steps.filter((s) => s.type === "script").length,
  };
}

// Pull an id out of an untrusted draft's header without trusting its shape.
function draftId(draft: unknown): string | undefined {
  const header = (draft as { workflow?: { id?: unknown } } | null)?.workflow;
  return typeof header?.id === "string" ? header.id : undefined;
}

export function makeWorkflowsControl(opts: {
  // Fire a workflow now — injected by the harbor (it owns the runner + its seams).
  // Absent → run is reported unavailable rather than silently dropped (mirrors routines).
  runNow?: (wf: Workflow) => void;
}): WorkflowsControl {
  return {
    list(): WorkflowSummary[] {
      return loadWorkflows().map(summarize);
    },

    get(idOrName: string): Workflow | undefined {
      return loadWorkflow((idOrName ?? "").trim());
    },

    save(draft: unknown): { ok: boolean; message?: string; id?: string } {
      // An edit keeps the draft's id; a create mints a fresh one. We inject the id into
      // the header BEFORE parsing so the required `workflow.id` is always present and the
      // client can't smuggle a malformed one (the schema + workflowFilePath re-check shape).
      const existingId = draftId(draft);
      const id = existingId ?? newWorkflowId();
      const header = (draft as { workflow?: Record<string, unknown> } | null)?.workflow ?? {};
      const candidate = { ...(draft as object), workflow: { ...header, id } };

      const parsed = Workflow.safeParse(candidate);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return { ok: false, message: `Invalid workflow: ${first ? `${first.path.join(".")} — ${first.message}` : "schema error"}.` };
      }
      const wf = parsed.data;

      const graphErrors = validateWorkflow(wf);
      if (graphErrors.length > 0) return { ok: false, message: `Invalid graph: ${graphErrors[0]}.` };

      // A rename must not collide with a *different* workflow's name (mirrors routines).
      const clash = loadWorkflows().find(
        (w) => w.workflow.name.toLowerCase() === wf.workflow.name.toLowerCase() && w.workflow.id !== id,
      );
      if (clash) return { ok: false, message: `A workflow named "${wf.workflow.name}" already exists.` };

      saveWorkflow(wf);
      return { ok: true, id, message: existingId ? `Updated "${wf.workflow.name}".` : `Created "${wf.workflow.name}".` };
    },

    remove(idOrName: string): { ok: boolean; message?: string } {
      const removed = removeWorkflow((idOrName ?? "").trim());
      return removed
        ? { ok: true, message: `Removed "${removed.workflow.name}".` }
        : { ok: false, message: "Not found." };
    },

    run(idOrName: string): { ok: boolean; message?: string } {
      const wf = findWorkflow(loadWorkflows(), (idOrName ?? "").trim());
      if (!wf) return { ok: false, message: "Not found." };
      if (!opts.runNow) return { ok: false, message: "The runner can't run this right now." };
      opts.runNow(wf);
      return { ok: true, message: `Running "${wf.workflow.name}" now.` };
    },
  };
}
