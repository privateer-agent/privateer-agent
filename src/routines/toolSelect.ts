// A routine's `tools` field mixes builtin tool names with MCP selectors. MCP tools
// are selected as "<server>__<tool>", and no Pi builtin name contains "__", so the
// separator is unambiguous: entries with "__" are MCP selectors — an exact tool name
// or a per-server wildcard "<server>__*" — everything else is a builtin allow-list
// entry.
//
// NOTE the selector is NOT the name Pi registers. pi-mcp-adapter names a tool
// "<serverPrefix>_<tool>" (one underscore), and Pi's `tools:` option is an exact-match
// Set — so a selector must be TRANSLATED before it can grant anything. That
// translation lives in ../mcp/toolNames.ts; this module only splits and matches.

export interface RoutineToolSplit {
  // Builtin tool names (read, glob, ...). Empty → caller falls back to the safe set.
  builtin: string[];
  // MCP selectors: "<server>__<tool>" exact, or "<server>__*" for a whole server.
  mcp: string[];
  // Unique server prefixes from `mcp`, i.e. which servers need connecting at all.
  servers: string[];
}

export function splitRoutineTools(tools?: string[]): RoutineToolSplit {
  const builtin: string[] = [];
  const mcp: string[] = [];
  const servers = new Set<string>();
  for (const t of tools ?? []) {
    const sep = t.indexOf("__");
    if (sep > 0) {
      mcp.push(t);
      servers.add(t.slice(0, sep));
    } else {
      builtin.push(t);
    }
  }
  return { builtin, mcp, servers: [...servers] };
}

// Does a SELECTOR-vocabulary tool name match a selector? Exact match, or "<server>__*"
// matching any tool on that server. Used to answer "does this routine already grant
// X?" against stored selectors — never against registered Pi tool names, which use a
// different separator (see ../mcp/toolNames.ts).
export function matchesSelector(name: string, selector: string): boolean {
  if (selector.endsWith("__*")) return name.startsWith(selector.slice(0, -1));
  return name === selector;
}
