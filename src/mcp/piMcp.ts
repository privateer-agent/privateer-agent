/**
 * Pi's MCP machinery for callers OUTSIDE a session: sign in to a connector, sign out,
 * ask whether it is signed in, and test that it answers.
 *
 * The desktop's connector manager is the caller (treeview desktop/src/main/
 * mcpService.ts). It used to reach into pi-mcp-adapter's OAuth flow for this; with
 * Pi's built-in MCP support, the tokens a session uses live in Pi's own store
 * (`agent/mcp-auth.json`, keyed by server name and URL), so anything that signs in has
 * to go through Pi or the session will not find the result.
 *
 * Sign-in and sign-out run Pi's own `mcp login` / `mcp logout` (runMcpCommand) — the
 * whole flow: connect, read the server's challenge, browser authorization against a
 * loopback callback, store, reconnect. The test builds the same McpServerConnection a
 * session builds, so "the test passed" means what a session will see, stored OAuth
 * tokens included.
 *
 * These are not in pi-coding-agent's package exports, so they are imported by file,
 * resolved from the package's own entry (which follows a hoisted install). Every deep
 * import of Pi's MCP internals lives HERE, behind small functions, and
 * tests/piMcp.test.ts pins each one against the installed Pi.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { agentDir } from "../config/paths.ts";

// Pi finds mcp-auth.json, mcp.log and its refresh locks through getAgentDir(), which
// reads this variable. Every Privateer entrypoint sets it in boot.ts; the desktop's
// main process, which calls these without running a session, may not have.
process.env.PI_CODING_AGENT_DIR ??= agentDir();

const PI_ENTRY = import.meta.resolve("@earendil-works/pi-coding-agent");
const piFile = (rel: string) => import(new URL(rel, PI_ENTRY).href);

export type McpAuthStatus = "not_supported" | "not_authenticated" | "authenticated";

/** Run one `pi mcp …` command against our agent dir; collect what it printed. */
async function mcpCommand(
  args: string[],
  opts: { openUrl?: (url: string) => void } = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const { runMcpCommand } = await piFile("./extensions/mcp/cli.js");
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMcpCommand(args, {
    // The user-level config only: these commands manage the connectors the user added,
    // never a project's.
    cwd: homedir(),
    agentDir: agentDir(),
    openUrl: opts.openUrl,
    log: (line: string) => out.push(line),
    error: (line: string) => err.push(line),
  });
  return { code, out, err };
}

/**
 * Sign in to an OAuth connector from mcp.json. `onUrl` gets the authorization URL —
 * the caller opens the browser and shows it. Already signed in → ok at once.
 */
export async function mcpSignIn(
  name: string,
  onUrl: (url: string) => void,
  timeoutMs = 5 * 60_000,
): Promise<{ ok: boolean; error?: string }> {
  const r = await mcpCommand(["login", name, "--timeout", String(Math.round(timeoutMs / 1000))], { openUrl: onUrl });
  return r.code === 0 ? { ok: true } : { ok: false, error: r.err.join("\n") || r.out.join("\n") || "sign-in failed" };
}

/** Delete the stored credentials of an OAuth connector. */
export async function mcpSignOut(name: string): Promise<void> {
  await mcpCommand(["logout", name]);
}

/**
 * Whether a connector has stored OAuth credentials. "not_supported" for a server Pi
 * would never start OAuth for: stdio, or HTTP carrying its own Authorization header.
 * A stored but expired access token still counts — Pi refreshes it on the next call.
 */
export async function mcpAuthStatus(server: {
  name: string;
  url?: string;
  headers?: Record<string, string>;
}): Promise<McpAuthStatus> {
  if (!server.url) return "not_supported";
  if (Object.keys(server.headers ?? {}).some((h) => h.toLowerCase() === "authorization")) return "not_supported";
  const { McpOAuthCredentialStore } = await piFile("./extensions/mcp/oauth.js");
  const tokens = new McpOAuthCredentialStore(undefined, undefined).tokens(server.name, server.url);
  return tokens ? "authenticated" : "not_authenticated";
}

export interface McpHandshake {
  ok: boolean;
  tools?: Array<{ name: string; description?: string }>;
  /** True when the server answered but wants a sign-in first. */
  needsAuth?: boolean;
  error?: string;
}

/**
 * Connect to one server exactly as a session would, list its tools, hang up. `config`
 * is a Pi `mcpServers` entry — what mcpControl / mcpService project into mcp.json.
 */
export async function mcpHandshake(name: string, config: Record<string, unknown>, timeoutMs = 20_000): Promise<McpHandshake> {
  const { McpServerConnection, createDefaultTransport, McpOAuthCredentialStore, McpServerLog } = await piFile(
    "./extensions/mcp/runtime.js",
  );
  const connection = new McpServerConnection({
    entry: { name, config, source: join(agentDir(), "mcp.json"), scope: "global" },
    cwd: homedir(),
    createTransport: createDefaultTransport,
    credentials: new McpOAuthCredentialStore(),
    log: new McpServerLog(join(agentDir(), "mcp.log")),
    onTools: () => {},
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connection.getClient(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    const tools = (connection.tools as Array<{ name: string; description?: string }>).map((t) => ({
      name: t.name,
      description: t.description,
    }));
    return { ok: true, tools };
  } catch (e) {
    if (connection.state === "needs-auth") return { ok: false, needsAuth: true, error: "sign-in required" };
    return { ok: false, error: connection.error ?? (e instanceof Error ? e.message : String(e)) };
  } finally {
    clearTimeout(timer);
    try {
      await connection.close();
    } catch {
      /* already gone */
    }
  }
}
