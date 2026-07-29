/**
 * Translating a routine's MCP selectors into the tool names Pi will actually honour.
 *
 * There are TWO vocabularies here and conflating them is why per-routine connector
 * allow-lists silently granted nothing:
 *
 *  • The SELECTOR vocabulary — "<server>__<tool>" exact, or "<server>__*" for a whole
 *    server. This is what a routine stores, what the app writes, and what the AI
 *    drafts. The double underscore is the point: no Pi builtin contains "__", so
 *    splitRoutineTools can tell a connector selector from a builtin name without a
 *    lookup table. This vocabulary is STABLE — routines on disk depend on it.
 *
 *  • The REGISTERED vocabulary — what pi-mcp-adapter actually names a tool when it
 *    registers it with Pi: `formatToolName()` → "<serverPrefix>_<tool>", ONE
 *    underscore, with dashes in the server name folded to underscores. And Pi's
 *    `tools:` option is an exact-match Set (`allowedToolNames`), so a literal
 *    "github__*" or even "github__create_issue" handed to it matches nothing at all.
 *
 * This module is the translation layer, mirroring pi-mcp-adapter's `getServerPrefix`
 * / `formatToolName` rather than importing them — the adapter ships as .ts in
 * node_modules and pulling it into our typecheck is the thing `harbor/index.ts`
 * already dodges with a variable import specifier. The mirror is four lines and is
 * pinned by tests/toolSelect.test.ts.
 *
 * The other half of the problem: per-tool names only EXIST when direct tools are
 * enabled. Otherwise the adapter exposes MCP through a single proxy tool named "mcp"
 * — all servers, all tools, one grant, which is precisely what a per-routine
 * allow-list is meant to avoid. So callers pair `names` with `directToolsEnv`, which
 * scopes MCP_DIRECT_TOOLS to exactly the selected server/tool pairs for that one run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../config/paths.ts";

export type PrefixMode = "server" | "none" | "short";

/** Mirrors pi-mcp-adapter's getServerPrefix. */
export function serverPrefix(serverName: string, mode: PrefixMode): string {
  if (mode === "none") return "";
  if (mode === "short") {
    const short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
    return short || "mcp";
  }
  return serverName.replace(/-/g, "_");
}

/** Mirrors pi-mcp-adapter's formatToolName. */
export function formatToolName(toolName: string, serverName: string, mode: PrefixMode): string {
  const p = serverPrefix(serverName, mode);
  return p ? `${p}_${toolName}` : toolName;
}

/** The cached tool inventory the adapter builds after connecting: server → tool names. */
export type McpInventory = Record<string, string[]>;

export interface ResolveInput {
  /** "<server>__<tool>" / "<server>__*" selectors, as stored on the routine. */
  selectors: string[];
  /** Server → the tool names it exposes, from the adapter's metadata cache. */
  inventory: McpInventory;
  /** The adapter's tool-prefix mode (mcp.json → settings.toolPrefix). */
  prefix: PrefixMode;
}

export interface ResolvedMcpTools {
  /** Exact registered tool names to hand to Pi's `tools:` allow-list. */
  names: string[];
  /** Servers touched by the selectors — the set that must be reachable this run. */
  servers: string[];
  /** MCP_DIRECT_TOOLS entries ("server/tool", or bare "server" for a wildcard). */
  directToolsEnv: string[];
  /**
   * Servers a selector named that the metadata cache knows nothing about. A wildcard
   * over one of these expands to NOTHING, so the caller must warm the cache before
   * building the session — see harbor/index.ts. Never silently ignore this.
   */
  coldServers: string[];
  /**
   * Exact selectors whose server DID report an inventory that doesn't contain that
   * tool — a typo, or a tool the connector dropped. The name is still granted (it
   * simply never registers), but the caller should say so rather than let the run
   * quietly come back thinner than asked for.
   */
  unknownTools: string[];
}

/**
 * Expand selectors against a known inventory. Pure — the file reads live in
 * `resolveMcpSelection` below so this stays trivially testable.
 *
 * An EXACT selector resolves without the inventory (we can compute the registered
 * name from the server + tool alone), so a connector whose cache entry is stale still
 * works. A WILDCARD needs the inventory to enumerate, which is why `coldServers`
 * exists.
 */
export function resolveMcpTools({ selectors, inventory, prefix }: ResolveInput): ResolvedMcpTools {
  const names: string[] = [];
  const servers: string[] = [];
  const directToolsEnv: string[] = [];
  const coldServers: string[] = [];
  const unknownTools: string[] = [];

  const push = <T>(arr: T[], v: T) => {
    if (!arr.includes(v)) arr.push(v);
  };

  for (const selector of selectors) {
    const sep = selector.indexOf("__");
    if (sep <= 0) continue; // not a selector; splitRoutineTools already routed it
    const server = selector.slice(0, sep);
    const tool = selector.slice(sep + 2);
    if (!tool) continue;
    push(servers, server);

    if (tool === "*") {
      const known = inventory[server];
      if (!known || known.length === 0) {
        push(coldServers, server);
        continue;
      }
      // Bare server name = "every tool on this server" to MCP_DIRECT_TOOLS.
      push(directToolsEnv, server);
      for (const t of known) push(names, formatToolName(t, server, prefix));
      continue;
    }

    push(names, formatToolName(tool, server, prefix));
    // MCP_DIRECT_TOOLS matches the ORIGINAL (unprefixed) tool name.
    push(directToolsEnv, `${server}/${tool}`);
    const known = inventory[server];
    if (!known || known.length === 0) push(coldServers, server);
    else if (!known.includes(tool)) push(unknownTools, selector);
  }

  return { names, servers, directToolsEnv, coldServers, unknownTools };
}

/** The adapter's metadata cache, as it lands on disk (agent/mcp-cache.json). */
export function readMcpInventory(dir: string = agentDir()): McpInventory {
  const out: McpInventory = {};
  try {
    const raw = JSON.parse(readFileSync(join(dir, "mcp-cache.json"), "utf8"));
    for (const [server, entry] of Object.entries<any>(raw?.servers ?? {})) {
      const tools = Array.isArray(entry?.tools)
        ? entry.tools.map((t: any) => String(t?.name ?? "")).filter(Boolean)
        : [];
      out[server] = tools;
    }
  } catch {
    /* no cache yet — every selected server is cold */
  }
  return out;
}

/**
 * The adapter's prefix mode. `mcpControl.project()` pins "server" into the file it
 * writes, so this is really a guard for a hand-written mcp.json.
 */
export function readPrefixMode(dir: string = agentDir()): PrefixMode {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
    const mode = raw?.settings?.toolPrefix;
    if (mode === "server" || mode === "none" || mode === "short") return mode;
  } catch {
    /* no config — the adapter's own default */
  }
  return "server";
}

/** Read-from-disk wrapper around resolveMcpTools. */
export function resolveMcpSelection(selectors: string[], dir: string = agentDir()): ResolvedMcpTools {
  return resolveMcpTools({
    selectors,
    inventory: readMcpInventory(dir),
    prefix: readPrefixMode(dir),
  });
}
