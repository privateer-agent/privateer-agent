import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tool, jsonSchema, type ToolSet } from "ai";
import { globalPaths, projectPaths } from "../config/paths.ts";
import { type PermissionGate, PermissionDeniedError } from "../permissions/gate.ts";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
export type McpServers = Record<string, McpServerConfig>;

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// Read mcp.json from project then user scope (project overrides). Accepts either a
// top-level map or a { "mcpServers": {...} } wrapper.
export function loadMcpServers(cwd: string = process.cwd()): McpServers {
  const merge = (path: string, into: McpServers) => {
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const map = (raw && typeof raw === "object" && raw.mcpServers) || raw;
      if (map && typeof map === "object") {
        for (const [name, cfg] of Object.entries(map as Record<string, unknown>)) {
          if (cfg && typeof cfg === "object" && typeof (cfg as any).command === "string") {
            into[name] = cfg as McpServerConfig;
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

const PROTOCOL_VERSION = "2024-11-05";

// A minimal JSON-RPC 2.0 client over an MCP server's stdio (newline-delimited JSON).
// Implements just what an agent needs: initialize, tools/list, tools/call.
export class McpStdioClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = "";

  constructor(
    private readonly name: string,
    private readonly cfg: McpServerConfig,
    private readonly cwd: string,
  ) {}

  async connect(timeoutMs = 10_000): Promise<void> {
    this.child = spawn(this.cfg.command, this.cfg.args ?? [], {
      cwd: this.cwd,
      env: { ...process.env, ...this.cfg.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d: string) => this.onData(d));
    this.child.on("error", (err) => this.failAll(err));
    this.child.on("exit", () => this.failAll(new Error(`MCP server "${this.name}" exited`)));

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "privateer", version: "0.1.0" },
    }, timeoutMs);
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpToolDef[]> {
    const res = await this.request("tools/list", {});
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const res = await this.request("tools/call", { name, arguments: args ?? {} });
    return formatContent(res);
  }

  close(): void {
    this.failAll(new Error("client closed"));
    this.child?.kill();
  }

  private write(msg: unknown): void {
    this.child?.stdin.write(JSON.stringify(msg) + "\n");
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  private request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON (server logging on stdout)
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error?.message ?? "MCP error"));
        else p.resolve(msg.result);
      }
      // notifications / server requests are ignored
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
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
  client: McpStdioClient,
  defs: McpToolDef[],
  gate: PermissionGate,
): ToolSet {
  const set: ToolSet = {};
  for (const d of defs) {
    const name = `${server}__${d.name}`;
    set[name] = tool({
      description: d.description ?? `${d.name} (MCP server: ${server})`,
      inputSchema: jsonSchema((d.inputSchema as any) ?? { type: "object", properties: {} }),
      execute: async (args: unknown) => {
        const decision = await gate.request({
          tool: name,
          kind: "fetch",
          title: `MCP ${server}: ${d.name}`,
          detail: JSON.stringify(args ?? {}).slice(0, 120),
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
  clients: McpStdioClient[];
  status: { server: string; tools: number; error?: string }[];
}

// Connect every configured server, returning the merged toolset, the live clients (to
// close on teardown), and a per-server status. Failures are isolated per server.
export async function connectMcpServers(
  servers: McpServers,
  cwd: string,
  gate: PermissionGate,
): Promise<McpConnection> {
  const tools: ToolSet = {};
  const clients: McpStdioClient[] = [];
  const status: McpConnection["status"] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const client = new McpStdioClient(name, cfg, cwd);
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
