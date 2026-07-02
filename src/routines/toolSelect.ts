import type { ToolSet } from "ai";

// A routine's `tools` field mixes builtin tool names with MCP selectors. MCP tools
// are namespaced "<server>__<tool>" (see adaptMcpTools), and no builtin name contains
// "__", so the separator is unambiguous: entries with "__" are MCP selectors — an
// exact tool name or a per-server wildcard "<server>__*" — everything else is a
// builtin allowlist entry.

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

// Does a namespaced MCP tool name match a selector? Exact match, or "<server>__*"
// matching any tool on that server.
export function matchesSelector(name: string, selector: string): boolean {
  if (selector.endsWith("__*")) return name.startsWith(selector.slice(0, -1));
  return name === selector;
}

// Narrow a connected MCP toolset to the selected tools. Least privilege matters here:
// routine runs use the auto-approve gate, so anything left in this set fires without
// a human in the loop.
export function filterMcpTools(tools: ToolSet, selectors: string[]): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => selectors.some((s) => matchesSelector(name, s))),
  );
}
