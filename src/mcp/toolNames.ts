/**
 * Translating a routine's MCP selectors into the tool names Pi registers.
 *
 * There are TWO vocabularies here:
 *
 *  • The SELECTOR vocabulary — "<server>__<tool>" exact, or "<server>__*" for a whole
 *    server. This is what a routine stores, what the app writes, and what the AI
 *    drafts. The double underscore is the point: no Pi builtin contains "__", so
 *    splitRoutineTools can tell a connector selector from a builtin name without a
 *    lookup table. This vocabulary is STABLE — routines on disk depend on it.
 *
 *  • The REGISTERED vocabulary — what Pi's built-in MCP support names a tool:
 *    "mcp__<server>__<tool>", with every character other than letters, digits and "_"
 *    replaced by "_" (pi-coding-agent docs/mcp.md, "Configuration rules").
 *
 * Pi's `tools:` option takes `*` patterns, and once any entry starts with "mcp__" it
 * keeps ONLY the MCP tools that match — so a selector translates to one allow-list
 * entry, wildcard included, with no tool inventory to consult and nothing to warm.
 * Mirrors Pi's naming rather than importing it so this stays Pi-free and testable;
 * pinned by tests/toolSelect.test.ts.
 */

import { createHash } from "node:crypto";

const NON_IDENT = /[^A-Za-z0-9_]/g;
// Pi's cap (extensions/mcp/tools.js MAX_TOOL_NAME_LENGTH); longer names get a hash.
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Pi's registered name for one MCP tool — createMcpToolName, including its shortening
 * of a name over 64 characters to a prefix plus a hash of server and tool. (Pi also
 * hashes two tools whose sanitized names collide; that depends on the live tool list
 * and can't be predicted from a selector.)
 */
export function mcpToolName(server: string, tool: string): string {
  const name = `mcp__${server}__${tool}`.replace(NON_IDENT, "_");
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

export interface ResolvedMcpTools {
  /** Entries for Pi's `tools:` allow-list — exact names, or "mcp__<server>__*". */
  patterns: string[];
  /** Servers touched by the selectors, in selector order. */
  servers: string[];
}

/** Translate stored selectors into Pi allow-list patterns. Pure. */
export function resolveMcpTools(selectors: string[]): ResolvedMcpTools {
  const patterns: string[] = [];
  const servers: string[] = [];
  const push = (arr: string[], v: string) => {
    if (!arr.includes(v)) arr.push(v);
  };
  for (const selector of selectors) {
    const sep = selector.indexOf("__");
    if (sep <= 0) continue; // not a selector; splitRoutineTools already routed it
    const server = selector.slice(0, sep);
    const tool = selector.slice(sep + 2);
    if (!tool) continue;
    push(servers, server);
    push(patterns, tool === "*" ? `${serverPrefix(server)}*` : mcpToolName(server, tool));
  }
  return { patterns, servers };
}

/** "mcp__<server>__", the start of every tool name of `server`. */
function serverPrefix(server: string): string {
  return `mcp__${server.replace(NON_IDENT, "_")}__`;
}

/** Does a registered tool name belong to `server`? */
export function isToolOfServer(registered: string, server: string): boolean {
  return registered.startsWith(serverPrefix(server));
}
