import { existsSync, readFileSync } from "node:fs";
import { tool, jsonSchema, type ToolSet } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { globalPaths, projectPaths } from "../config/paths.ts";
import { type PermissionGate, PermissionDeniedError } from "../permissions/gate.ts";
import { FileOAuthProvider, type AuthorizePrompt } from "./oauth.ts";

// A local stdio server (launched as a child process) or a remote HTTP server.
export type StdioServerConfig = { command: string; args?: string[]; env?: Record<string, string> };
export type HttpServerConfig = { url: string; headers?: Record<string, string>; transport?: "http" | "sse" };
export type McpServerConfig = StdioServerConfig | HttpServerConfig;
export type McpServers = Record<string, McpServerConfig>;

function isStdio(cfg: McpServerConfig): cfg is StdioServerConfig {
  return typeof (cfg as StdioServerConfig).command === "string";
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  // Standard MCP behavioral hints. We use `destructiveHint`/`readOnlyHint` to
  // decide whether a tool may auto-approve: a tool that performs an irreversible
  // external action marks itself destructive so it ALWAYS reaches the human.
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

// Read mcp.json from project then user scope (project overrides). Accepts either a
// top-level map or a { "mcpServers": {...} } wrapper. An entry is kept if it names a
// stdio `command` or a remote `url`; anything else is dropped.
export function loadMcpServers(cwd: string = process.cwd()): McpServers {
  const merge = (path: string, into: McpServers) => {
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const map = (raw && typeof raw === "object" && raw.mcpServers) || raw;
      if (map && typeof map === "object") {
        for (const [name, cfg] of Object.entries(map as Record<string, unknown>)) {
          if (cfg && typeof cfg === "object") {
            const c = cfg as Partial<StdioServerConfig & HttpServerConfig>;
            if (typeof c.command === "string" || typeof c.url === "string") {
              into[name] = cfg as McpServerConfig;
            }
          }
        }
      }
    } catch {
      /* malformed mcp.json → skip */
    }
  };
  const servers: McpServers = {};
  merge(globalPaths().mcp, servers);
  merge(projectPaths(cwd).mcp, servers);
  return servers;
}

// process.env as a clean string map, so stdio servers inherit our environment
// (StdioClientTransport otherwise launches with a minimal default env).
function inheritedEnv(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  return { ...base, ...extra };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then((v) => (clearTimeout(timer), resolve(v)), (e) => (clearTimeout(timer), reject(e)));
  });
}

// An MCP client over the official SDK, transport chosen from config: a local child
// process (stdio) or a remote server (Streamable HTTP, falling back to legacy SSE).
// Exposes only what the agent needs: connect, tools/list, tools/call, close.
export class McpClient {
  private client?: Client;

  constructor(
    private readonly name: string,
    private readonly cfg: McpServerConfig,
    private readonly cwd: string,
    private readonly onAuthorize?: AuthorizePrompt,
  ) {}

  async connect(timeoutMs = 10_000): Promise<void> {
    const client = new Client({ name: "privateer", version: "0.1.0" }, { capabilities: {} });
    if (isStdio(this.cfg)) {
      const transport = new StdioClientTransport({
        command: this.cfg.command,
        args: this.cfg.args ?? [],
        env: inheritedEnv(this.cfg.env),
        cwd: this.cwd,
        stderr: "ignore", // keep server logs out of the TUI
      });
      await withTimeout(client.connect(transport), timeoutMs, `MCP server "${this.name}" connect`);
      this.client = client;
      return;
    }

    const url = new URL(this.cfg.url);
    const requestInit = this.cfg.headers ? { headers: this.cfg.headers } : undefined;
    // Static header auth wins. Otherwise attach an interactive OAuth provider — it
    // stays dormant unless the server actually answers 401.
    const authProvider = this.cfg.headers
      ? undefined
      : new FileOAuthProvider(this.name, this.cfg.url, this.onAuthorize);
    const sse = () => new SSEClientTransport(url, { requestInit, authProvider });

    if (this.cfg.transport === "sse") {
      await this.tryConnect(client, sse, authProvider, timeoutMs);
    } else {
      const http = () => new StreamableHTTPClientTransport(url, { requestInit, authProvider });
      try {
        await this.tryConnect(client, http, authProvider, timeoutMs);
      } catch (err) {
        // A server that only speaks the legacy HTTP+SSE transport rejects the
        // Streamable-HTTP handshake; retry once over SSE before giving up.
        if (this.cfg.transport !== "http") await this.tryConnect(client, sse, authProvider, timeoutMs);
        else throw err;
      }
    }
    this.client = client;
  }

  // Connect with one transport kind. On a 401 with an OAuth provider configured,
  // run the interactive consent dance (browser → loopback redirect → code →
  // token exchange) and reconnect with a fresh transport that picks up the tokens.
  private async tryConnect(
    client: Client,
    make: () => StreamableHTTPClientTransport | SSEClientTransport,
    provider: FileOAuthProvider | undefined,
    timeoutMs: number,
  ): Promise<void> {
    const transport = make();
    try {
      await withTimeout(client.connect(transport), timeoutMs, `MCP server "${this.name}" connect`);
    } catch (err) {
      if (err instanceof UnauthorizedError && provider) {
        const code = await provider.waitForCode();
        await transport.finishAuth(code);
        await withTimeout(client.connect(make()), timeoutMs, `MCP server "${this.name}" reconnect`);
      } else {
        throw err;
      }
    }
  }

  async listTools(): Promise<McpToolDef[]> {
    const res = await this.client!.listTools();
    return Array.isArray(res?.tools)
      ? res.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
          annotations: t.annotations as McpToolDef["annotations"],
        }))
      : [];
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const res = await this.client!.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> });
    return formatContent(res);
  }

  close(): void {
    void this.client?.close();
  }
}

function formatContent(result: any): string {
  const content = result?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((c: any) => (c?.type === "text" ? c.text : `[${c?.type ?? "content"}]`))
      .join("\n");
    return result?.isError ? `Error: ${text}` : text || "(no output)";
  }
  return JSON.stringify(result ?? {});
}

// Adapt one server's MCP tools into AI-SDK tools, namespaced as "<server>__<tool>" and
// routed through the permission gate (MCP calls are external, so they prompt by default).
export function adaptMcpTools(
  server: string,
  client: McpClient,
  defs: McpToolDef[],
  gate: PermissionGate,
): ToolSet {
  const set: ToolSet = {};
  for (const d of defs) {
    const name = `${server}__${d.name}`;
    // A mutating tool (e.g. send email, delete file) marks itself destructive. We
    // map that to `alwaysAsk`, which the gate never auto-approves — so it always
    // prompts the human (phone on remote turns, terminal otherwise) even under
    // bypass mode or the allowlist. Read-only tools follow the normal policy.
    const destructive = d.annotations?.destructiveHint === true && d.annotations?.readOnlyHint !== true;
    set[name] = tool({
      description: d.description ?? `${d.name} (MCP server: ${server})`,
      inputSchema: jsonSchema((d.inputSchema as any) ?? { type: "object", properties: {} }),
      execute: async (args: unknown) => {
        const decision = await gate.request({
          tool: name,
          kind: "fetch",
          title: `MCP ${server}: ${d.name}`,
          detail: JSON.stringify(args ?? {}).slice(0, 120),
          alwaysAsk: destructive,
        });
        if (decision === "deny") throw new PermissionDeniedError(name);
        return client.callTool(d.name, args);
      },
    });
  }
  return set;
}

export interface McpConnection {
  tools: ToolSet;
  clients: McpClient[];
  status: { server: string; tools: number; error?: string }[];
}

// Connect every configured server, returning the merged toolset, the live clients (to
// close on teardown), and a per-server status. Failures are isolated per server.
export async function connectMcpServers(
  servers: McpServers,
  cwd: string,
  gate: PermissionGate,
  onAuthorize?: AuthorizePrompt,
): Promise<McpConnection> {
  const tools: ToolSet = {};
  const clients: McpClient[] = [];
  const status: McpConnection["status"] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const client = new McpClient(name, cfg, cwd, onAuthorize);
    try {
      await client.connect();
      const defs = await client.listTools();
      Object.assign(tools, adaptMcpTools(name, client, defs, gate));
      clients.push(client);
      status.push({ server: name, tools: defs.length });
    } catch (err) {
      client.close();
      status.push({ server: name, tools: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { tools, clients, status };
}
