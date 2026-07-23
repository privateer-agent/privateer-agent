import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { globalDir } from "../config/paths.ts";
import { Workflow, validateWorkflow } from "./schema.ts";

/**
 * Workflow persistence — the sibling of routines/store.ts, but ONE FILE PER WORKFLOW.
 *
 * Routines are many small records in a single routines.json; a workflow is a larger,
 * authored graph, so each lives in its own file under ~/.privateer/workflows/ (§8.3).
 * The canonical on-disk format the app writes is `w-<id>.json`. Hand-authored `*.yaml`
 * is a deliberate follow-up (needs a YAML parser + an async loader) — this skeleton
 * stays dependency-free by reading/writing JSON only.
 *
 * A workflow file is an EXECUTABLE control artifact (it can run `script` steps), so —
 * exactly like routines.json — every file is written owner-only (0600) inside the
 * owner-only (0700) global dir. The signed-frame gate (workflowsControl + authorizeControl)
 * is what stops the untrusted relay from writing one; these fs perms stop other local
 * users from reading/altering it (the §6.5 machine-local trust root).
 */

export function workflowsDir(): string {
  return join(globalDir(), "workflows");
}

// The canonical path for a workflow id. Ids are `w-<ts>` (see newWorkflowId) — already
// filesystem-safe — but we re-assert the shape so a hostile id can never escape the dir.
export function workflowFilePath(id: string): string {
  if (!/^w-[a-zA-Z0-9]+$/.test(id)) throw new Error(`unsafe workflow id "${id}"`);
  return join(workflowsDir(), `${id}.json`);
}

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* non-POSIX filesystem or insufficient perms — nothing we can do */
  }
}

// Parse + fully validate one file's contents into a Workflow, or null if it's corrupt,
// fails the strict schema, or has a broken route graph. Per-file so ONE bad file never
// hides the rest (unlike routines' single-file all-or-nothing load).
function parseWorkflow(raw: string): Workflow | null {
  try {
    const parsed = Workflow.parse(JSON.parse(raw));
    if (validateWorkflow(parsed).length > 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

// All valid workflows on disk, sorted by name. Corrupt/invalid files are skipped, not
// thrown — a hand-mangled file shouldn't take down the harbor or the app's list.
export function loadWorkflows(): Workflow[] {
  const dir = workflowsDir();
  if (!existsSync(dir)) return [];
  const out: Workflow[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue; // .yaml authoring is a follow-up
    try {
      const wf = parseWorkflow(readFileSync(join(dir, entry), "utf8"));
      if (wf) out.push(wf);
    } catch {
      /* unreadable file — skip */
    }
  }
  return out.sort((a, b) => a.workflow.name.localeCompare(b.workflow.name));
}

// Look up by id first, then by (case-insensitive) name — mirrors findRoutine.
export function findWorkflow(workflows: Workflow[], idOrName: string): Workflow | undefined {
  const needle = idOrName.trim().toLowerCase();
  return (
    workflows.find((w) => w.workflow.id === idOrName) ??
    workflows.find((w) => w.workflow.name.toLowerCase() === needle)
  );
}

// Load a single workflow by id or name (the app's editor fetches the full graph).
export function loadWorkflow(idOrName: string): Workflow | undefined {
  return findWorkflow(loadWorkflows(), idOrName);
}

// Write a workflow to its own file (create or overwrite by id). Caller has already
// schema-validated it (workflowsControl.save) — we re-assert nothing here beyond the
// id-shape guard in workflowFilePath.
export function saveWorkflow(wf: Workflow): void {
  const dir = workflowsDir();
  mkdirSync(dir, { recursive: true });
  tryChmod(dir, 0o700);
  const path = workflowFilePath(wf.workflow.id);
  writeFileSync(path, JSON.stringify(wf, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  tryChmod(path, 0o600);
}

// Remove a workflow by id or name. Returns the removed workflow, or null if absent.
export function removeWorkflow(idOrName: string): Workflow | null {
  const target = findWorkflow(loadWorkflows(), idOrName);
  if (!target) return null;
  try {
    unlinkSync(workflowFilePath(target.workflow.id));
  } catch {
    return null; // already gone / unwritable
  }
  return target;
}
