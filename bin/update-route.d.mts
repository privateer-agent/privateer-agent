// Types for the `privateer update` argv router. Same reason as apply-patches.d.mts:
// the implementation is plain .mjs because bin/ runs under a bare `node`, before any
// transpiler exists — but the tests that pin the grammar are TypeScript.

/** Which half of `privateer update` the argv after the subcommand asks for. */
export function routeUpdate(rest: string[] | undefined): "self" | "packs" | "all" | "help";
