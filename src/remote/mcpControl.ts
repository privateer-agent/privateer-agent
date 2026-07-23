/**
 * MCP connector management for the app — the sibling of channelsControl.ts, but for
 * MCP server config rather than messaging channels. It is what lets the phone/web
 * client add, toggle, and remove MCP connectors on a Node HOST it drives over the
 * relay (the harbor today; an interactive terminal by the same shape).
 *
 * The client itself can NEVER run MCP — a browser tab / RN runtime can't spawn a
 * stdio child or hold the adapter. So "serving MCP to phone/web" means MANAGING the
 * config here, on a host that executes it. This control owns that config.
 *
 * SAME FILE MODEL AS THE DESKTOP (treeview/desktop/src/main/mcpService.ts): the
 * source of truth is `${agentDir}/mcp-desktop.json` — every server with an `enabled`
 * flag — and from it we PROJECT the standard `${agentDir}/mcp.json` (enabled servers
 * only, `{mcpServers:{}}` shape) that pi-mcp-adapter reads. Sharing those two files
 * means a machine has ONE coherent MCP config whether it was edited from the desktop
 * over IPC or from the phone over the relay.
 *
 * SECRETS: MCP env values are credentials (GITHUB_PERSONAL_ACCESS_TOKEN, …). Over the
 * untrusted relay they are WRITE-ONLY, exactly like channel bot tokens: list() NEVER
 * returns an env VALUE — only which env keys exist (`envKeys`) and which are non-empty
 * (`secretsSet`), by name. save() persists whatever env VALUES it is handed in
 * `draft.env`; the seal/open of those values in transit is the caller's job (the
 * harbor opens a sealed-box addressed to its terminal, mirroring applyChannelSave), so
 * this module only ever deals in the plaintext files it already owns.
 *
 * Framework-agnostic: nothing here imports React or the relay. The caller owns the
 * frame plumbing and the sealed-secret open.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentDir } from "../config/paths.ts";

export type McpTransport = "stdio" | "http";

// One server as stored in the source file (mcp-desktop.json). Mirrors the desktop's
// SourceEntry: the standard fields the adapter needs plus our `enabled` flag.
interface SourceEntry {
  transport?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  oauth?: boolean;
  enabled?: boolean;
}
interface SourceFile {
  servers: Record<string, SourceEntry>;
}

// Non-secret projection of one server, sent to the app. No env VALUES, ever — only
// which env keys exist and which are set (`secretsSet`). `host` is surfaced for the
// app's privacy badge ("Sends data to <host>" for http; stdio runs locally).
export interface RemoteMcpServer {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  command?: string; // stdio: the launch binary (not a secret — e.g. "npx")
  argsPreview?: string; // stdio: args joined, for a one-line summary
  url?: string; // http: the endpoint (not a secret; the vendor host)
  host?: string; // http: parsed host for the privacy badge
  oauth: boolean; // http servers negotiate OAuth; stdio never does
  envKeys: string[]; // env var NAMES only (e.g. ["GITHUB_PERSONAL_ACCESS_TOKEN"])
  secretsSet: string[]; // subset of envKeys whose value is non-empty — names only
}

// An app-submitted edit. Non-secret fields REPLACE when present; `env` maps a var
// name → its (already-opened) value, and only present, non-empty values overwrite —
// an omitted key keeps the existing value (so a re-save without re-typing the token
// preserves it, matching the channels-manager rule).
export interface McpDraft {
  name: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  oauth?: boolean;
  env?: Record<string, string>;
}

export interface McpControl {
  // Every managed server, non-secret projection. Enabled or not — the app shows
  // disabled connectors so they can be toggled back on.
  list(): RemoteMcpServer[];
  // Create or edit a server. Validates transport ⟷ required field (stdio→command,
  // http→url). Returns a one-line result. Re-projects mcp.json on success.
  save(draft: McpDraft): { ok: boolean; message?: string };
  // Enable/disable a server (re-projects). ok:false when the name is unknown.
  setEnabled(name: string, enabled: boolean): { ok: boolean; message?: string };
  // Delete a server entirely (re-projects). ok:false when nothing was configured.
  remove(name: string): { ok: boolean; message?: string };
}

const TRANSPORTS: readonly McpTransport[] = ["stdio", "http"];
function isTransport(v: unknown): v is McpTransport {
  return typeof v === "string" && TRANSPORTS.includes(v as McpTransport);
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function cleanArgs(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => String(x ?? "")).filter((s) => s.length > 0);
}

export function makeMcpControl(opts?: {
  // Override the source/projection dir (tests). Defaults to the shared agent dir, so
  // this control and the desktop's mcpService edit the SAME two files.
  dir?: () => string;
}): McpControl {
  const dir = opts?.dir ?? agentDir;
  const sourcePath = () => join(dir(), "mcp-desktop.json");
  const projectionPath = () => join(dir(), "mcp.json");

  function readSource(): SourceFile {
    // Seed from an existing standard mcp.json on first run (a machine that already
    // had connectors before this control existed), so nothing is silently dropped.
    try {
      const raw = JSON.parse(readFileSync(sourcePath(), "utf8"));
      if (raw && typeof raw === "object" && raw.servers) return { servers: raw.servers };
    } catch {
      /* fall through to seed */
    }
    const servers: Record<string, SourceEntry> = {};
    try {
      const proj = JSON.parse(readFileSync(projectionPath(), "utf8"));
      for (const [name, entry] of Object.entries(proj?.mcpServers ?? {})) {
        servers[name] = { ...(entry as SourceEntry), enabled: true };
      }
    } catch {
      /* no prior config */
    }
    return { servers };
  }

  function writeSource(src: SourceFile): void {
    mkdirSync(dirname(sourcePath()), { recursive: true });
    writeFileSync(sourcePath(), JSON.stringify(src, null, 2) + "\n");
    project(src);
  }

  // Project the enabled servers into the standard mcp.json the adapter reads. An
  // entry with no explicit transport is treated as stdio if it has a command, http
  // if it has a url — matching the adapter's own inference.
  function project(src: SourceFile): void {
    const mcpServers: Record<string, unknown> = {};
    for (const [name, e] of Object.entries(src.servers)) {
      if (e.enabled === false) continue;
      const { enabled, ...std } = e;
      mcpServers[name] = std;
    }
    mkdirSync(dirname(projectionPath()), { recursive: true });
    writeFileSync(projectionPath(), JSON.stringify({ mcpServers }, null, 2) + "\n");
  }

  function toRemote(name: string, e: SourceEntry): RemoteMcpServer {
    const transport: McpTransport = e.transport ?? (e.url ? "http" : "stdio");
    const env = e.env ?? {};
    const envKeys = Object.keys(env);
    return {
      name,
      transport,
      enabled: e.enabled !== false,
      command: transport === "stdio" ? e.command : undefined,
      argsPreview: transport === "stdio" && e.args?.length ? e.args.join(" ") : undefined,
      url: transport === "http" ? e.url : undefined,
      host: transport === "http" && e.url ? hostOf(e.url) : undefined,
      // http servers negotiate OAuth; stdio never does (matches mcpService.list()).
      oauth: transport === "http",
      envKeys,
      secretsSet: envKeys.filter((k) => String(env[k] ?? "").length > 0),
    };
  }

  return {
    list(): RemoteMcpServer[] {
      const src = readSource();
      return Object.entries(src.servers).map(([name, e]) => toRemote(name, e));
    },

    save(draft: McpDraft): { ok: boolean; message?: string } {
      const name = String(draft?.name ?? "").trim();
      if (!name) return { ok: false, message: "A connector needs a name." };
      if (draft.transport !== undefined && !isTransport(draft.transport))
        return { ok: false, message: "Unknown transport." };

      const src = readSource();
      const prev: SourceEntry = src.servers[name] ?? {};
      const entry: SourceEntry = { ...prev };

      const transport: McpTransport =
        (draft.transport as McpTransport) ?? prev.transport ?? (draft.url || prev.url ? "http" : "stdio");
      entry.transport = transport;

      if (transport === "stdio") {
        if (draft.command !== undefined) entry.command = String(draft.command).trim();
        const args = cleanArgs(draft.args);
        if (args !== undefined) entry.args = args;
        // A stdio server can't reach a url and never does OAuth — clear stale fields.
        delete entry.url;
        delete entry.oauth;
        if (!entry.command) return { ok: false, message: "A local (stdio) connector needs a command." };
      } else {
        if (draft.url !== undefined) entry.url = String(draft.url).trim();
        if (draft.oauth !== undefined) entry.oauth = !!draft.oauth;
        delete entry.command;
        delete entry.args;
        if (!entry.url) return { ok: false, message: "A remote (http) connector needs a URL." };
      }

      // Env/secrets: a present, non-empty value overwrites; an omitted key keeps the
      // existing value (re-save without re-typing the token preserves it). An explicit
      // empty string clears that key.
      if (draft.env !== undefined) {
        const merged: Record<string, string> = { ...(prev.env ?? {}) };
        for (const [k, v] of Object.entries(draft.env)) {
          const key = String(k).trim();
          if (!key) continue;
          const val = String(v ?? "");
          if (val.length > 0) merged[key] = val;
          else delete merged[key];
        }
        if (Object.keys(merged).length > 0) entry.env = merged;
        else delete entry.env;
      }

      // A brand-new server comes up enabled; an edit preserves the prior flag.
      entry.enabled = prev.enabled ?? true;

      src.servers[name] = entry;
      try {
        writeSource(src);
      } catch (e) {
        return { ok: false, message: `Couldn't write MCP config: ${e instanceof Error ? e.message : String(e)}` };
      }
      return { ok: true, message: `Saved "${name}".` };
    },

    setEnabled(name: string, enabled: boolean): { ok: boolean; message?: string } {
      const src = readSource();
      if (!src.servers[name]) return { ok: false, message: "No such connector." };
      src.servers[name].enabled = !!enabled;
      try {
        writeSource(src);
      } catch (e) {
        return { ok: false, message: `Couldn't write MCP config: ${e instanceof Error ? e.message : String(e)}` };
      }
      return { ok: true, message: `${enabled ? "Enabled" : "Disabled"} "${name}".` };
    },

    remove(name: string): { ok: boolean; message?: string } {
      const src = readSource();
      if (!src.servers[name]) return { ok: false, message: "Not configured." };
      delete src.servers[name];
      try {
        writeSource(src);
      } catch (e) {
        return { ok: false, message: `Couldn't write MCP config: ${e instanceof Error ? e.message : String(e)}` };
      }
      return { ok: true, message: `Removed "${name}".` };
    },
  };
}
