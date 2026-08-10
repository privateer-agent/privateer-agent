// Types for `privateer verify`. The implementation is plain .mjs for the same
// reason apply-patches.mjs is: bin/ runs under a bare `node`, before any transpiler.

/**
 * Check the install rooted at `repo` and print a report. Returns a process exit
 * code: 0 when nothing FAILED (inconclusive checks are not failures), 1 otherwise.
 *
 * `offline` skips every check that needs the npm registry.
 */
export function verify(opts: { repo: string; offline?: boolean }): Promise<number>;
