// Types for the launcher's patch/resolve helpers. The implementation is plain .mjs
// because bin/ must run under a bare `node` with no transpiler (the launcher is the
// very first thing to execute, before tsx/jiti are in play).

/** Directory CONTAINING the node_modules that holds `name`, or null if not installed. */
export function findDepRoot(from: string, name: string): string | null;

/** Absolute path to a file inside an installed dependency, or null if absent. */
export function resolveDep(from: string, name: string, ...rest: string[]): string | null;

/**
 * Apply `patches/` into whichever node_modules the targets landed in. Idempotent and
 * best-effort; see the implementation for why this runs at launch, not on install.
 */
export function applyPatchesIfNeeded(
  repo: string,
  nodeBin?: string,
): "current" | "applied" | "skipped" | "failed";
