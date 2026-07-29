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
 * SECRETS: MCP env values are credentials (GITHUB_PERSONAL_ACCESS_TOKEN, …), and so
 * are a `bearerToken` and every HTTP header VALUE (an `Authorization:` header is a
 * credential by construction). Over the untrusted relay all three are WRITE-ONLY,
 * exactly like channel bot tokens: list() NEVER returns one — only which keys exist
 * (`envKeys` / `headerKeys`) and which are non-empty (`secretsSet` / `headersSet`),
 * by name, plus a `bearerTokenSet` boolean. `bearerTokenEnv` IS returned: it is a
 * variable NAME, not a value. save() persists whatever values it is handed; the
 * seal/open of those values in transit is the caller's job (the harbor opens a
 * sealed-box addressed to its terminal, mirroring applyChannelSave, and REFUSES a
 * secret that arrived unsealed), so this module only ever deals in the plaintext files
 * it already owns.
 *
 * SCOPE — bearer tokens are a LOCAL/DESKTOP capability. A hosted (Harbor) agent gets
 * OAuth connectors only, because its home is tmpfs and a durable secret would have to
 * rest somewhere we can read; see treeview/docs/HARBOR_CONNECTORS_PLAN.md §2, decided
 * Option B. Nothing here may become the mechanism for storing a hosted credential.
 *
 * Framework-agnostic: nothing here imports React or the relay. The caller owns the
 * frame plumbing and the sealed-secret open.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentDir } from "../config/paths.ts";

export type McpTransport = "stdio" | "http";

/**
 * How an HTTP connector authenticates — our vocabulary, projected onto the adapter's
 * `auth` field. "none" is a server that needs no credential at all (or carries one
 * entirely in custom headers); stdio connectors are always "none".
 */
export type McpAuth = "oauth" | "bearer" | "none";

// One server as stored in the source file (mcp-desktop.json). Mirrors the desktop's
// SourceEntry: the standard fields the adapter needs plus our `enabled` flag.
interface SourceEntry {
  transport?: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: McpAuth;
  bearerToken?: string;
  bearerTokenEnv?: string;
  // LEGACY, read-only: entries written before `auth` existed carry a boolean here.
  // authOf() folds it in; nothing new ever writes it, and project() never emits it
  // (the adapter's own `oauth` field is an OAuthConfig object, not a boolean).
  oauth?: boolean;
  enabled?: boolean;
}
interface SourceFile {
  servers: Record<string, SourceEntry>;
}

const AUTHS: readonly McpAuth[] = ["oauth", "bearer", "none"];
function isAuth(v: unknown): v is McpAuth {
  return typeof v === "string" && AUTHS.includes(v as McpAuth);
}

// What this entry will actually do when it connects. Explicit `auth` wins; a bearer
// token implies bearer; a legacy `oauth: false` means no auth; otherwise HTTP servers
// auto-detect OAuth, which is the adapter's own default.
//
// The headers rule mirrors pi-mcp-adapter's supportsOAuth(): "configured custom headers
// take precedence over implicit OAuth auto-detection." Without this we'd project an
// EXPLICIT auth:"oauth" for a headers-carrying entry, and the adapter checks
// auth === "oauth" BEFORE its headers check — so we'd force OAuth on exactly the
// connectors it means to skip it for. Only implicit auth defers to headers; an explicit
// `auth` from the user still wins.
function authOf(e: SourceEntry, transport: McpTransport): McpAuth {
  if (transport !== "http") return "none";
  if (isAuth(e.auth)) return e.auth;
  if (e.bearerToken || e.bearerTokenEnv) return "bearer";
  if (e.oauth === false) return "none";
  if (e.headers && Object.keys(e.headers).length > 0) return "none";
  return "oauth";
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
  auth: McpAuth; // what this connector will actually do to authenticate
  // Kept for app builds that predate `auth`. True only for a real OAuth connector —
  // it used to mean "is an http server", which claimed OAuth for bearer/no-auth ones.
  oauth: boolean;
  envKeys: string[]; // env var NAMES only (e.g. ["GITHUB_PERSONAL_ACCESS_TOKEN"])
  secretsSet: string[]; // subset of envKeys whose value is non-empty — names only
  headerKeys: string[]; // http: header NAMES only — values are credentials
  headersSet: string[]; // subset of headerKeys whose value is non-empty — names only
  bearerTokenSet: boolean; // http: a static bearer token is stored (never its value)
  bearerTokenEnv?: string; // http: the env var the token is read from — a NAME, safe
}

// An app-submitted edit. Non-secret fields REPLACE when present; `env` and `headers`
// map a key → its (already-opened) value, and only present, non-empty values
// overwrite — an omitted key keeps the existing value (so a re-save without re-typing
// the token preserves it, matching the channels-manager rule), while an explicit
// empty string clears it. `bearerToken` follows the same rule as a single value.
export interface McpDraft {
  name: string;
  transport?: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  auth?: McpAuth;
  // Legacy alias for `auth` — true → "oauth", false → "none". `auth` wins if both.
  oauth?: boolean;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  bearerToken?: string;
  bearerTokenEnv?: string;
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
  //
  // `toolPrefix` is pinned rather than left to the adapter's default because a
  // routine's "<server>__<tool>" selector is translated into a REGISTERED tool name
  // before it can grant anything (src/mcp/toolNames.ts), and that translation depends
  // on the mode. "server" is the adapter's own default, so pinning it changes nothing
  // today and stops a future default flip from silently voiding every allow-list.
  function project(src: SourceFile): void {
    const mcpServers: Record<string, unknown> = {};
    for (const [name, e] of Object.entries(src.servers)) {
      if (e.enabled === false) continue;
      mcpServers[name] = toStandard(e);
    }
    mkdirSync(dirname(projectionPath()), { recursive: true });
    writeFileSync(
      projectionPath(),
      JSON.stringify({ mcpServers, settings: { toolPrefix: "server" } }, null, 2) + "\n",
    );
  }

  // One managed entry as pi-mcp-adapter's ServerEntry. Built field by field rather
  // than spread, because our vocabulary and the adapter's differ in two places that
  // matter: our `auth: "none"` is its `auth: false`, and our legacy boolean `oauth`
  // collides with its `oauth` (an OAuthConfig OBJECT) and must never reach the file.
  //
  // Getting `auth` right is load-bearing, not cosmetic. The adapter only attaches an
  // Authorization header when `auth === "bearer"` (server-manager.ts), and its
  // supportsOAuth() refuses OAuth outright once custom headers are configured — so an
  // omitted `auth` silently means "no bearer token was ever sent".
  function toStandard(e: SourceEntry): Record<string, unknown> {
    const transport: McpTransport = e.transport ?? (e.url ? "http" : "stdio");
    const std: Record<string, unknown> = {};
    if (transport === "stdio") {
      if (e.command) std.command = e.command;
      if (e.args?.length) std.args = e.args;
    } else {
      if (e.url) std.url = e.url;
      if (e.headers && Object.keys(e.headers).length > 0) std.headers = e.headers;
      const auth = authOf(e, transport);
      if (auth === "bearer") {
        std.auth = "bearer";
        if (e.bearerToken) std.bearerToken = e.bearerToken;
        if (e.bearerTokenEnv) std.bearerTokenEnv = e.bearerTokenEnv;
      } else if (auth === "oauth") {
        std.auth = "oauth";
      } else {
        std.auth = false;
      }
    }
    if (e.env && Object.keys(e.env).length > 0) std.env = e.env;
    return std;
  }

  function toRemote(name: string, e: SourceEntry): RemoteMcpServer {
    const transport: McpTransport = e.transport ?? (e.url ? "http" : "stdio");
    const env = e.env ?? {};
    const envKeys = Object.keys(env);
    const headers = transport === "http" ? e.headers ?? {} : {};
    const headerKeys = Object.keys(headers);
    const auth = authOf(e, transport);
    return {
      name,
      transport,
      enabled: e.enabled !== false,
      command: transport === "stdio" ? e.command : undefined,
      argsPreview: transport === "stdio" && e.args?.length ? e.args.join(" ") : undefined,
      url: transport === "http" ? e.url : undefined,
      host: transport === "http" && e.url ? hostOf(e.url) : undefined,
      auth,
      oauth: auth === "oauth",
      envKeys,
      secretsSet: envKeys.filter((k) => String(env[k] ?? "").length > 0),
      headerKeys,
      headersSet: headerKeys.filter((k) => String(headers[k] ?? "").length > 0),
      bearerTokenSet: transport === "http" && String(e.bearerToken ?? "").length > 0,
      bearerTokenEnv: transport === "http" ? e.bearerTokenEnv : undefined,
    };
  }

  // Merge a submitted key/value map into the stored one: a present non-empty value
  // overwrites, an explicit empty string clears that key, an omitted key is left
  // alone. Shared by `env` and `headers` so the "re-save without re-typing the token"
  // rule can't drift between them. Returns undefined when nothing is left.
  function mergeSecrets(
    prev: Record<string, string> | undefined,
    submitted: Record<string, string>,
  ): Record<string, string> | undefined {
    const merged: Record<string, string> = { ...(prev ?? {}) };
    for (const [k, v] of Object.entries(submitted)) {
      const key = String(k).trim();
      if (!key) continue;
      const val = String(v ?? "");
      if (val.length > 0) merged[key] = val;
      else delete merged[key];
    }
    return Object.keys(merged).length > 0 ? merged : undefined;
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
      if (draft.auth !== undefined && !isAuth(draft.auth))
        return { ok: false, message: "Unknown authentication type." };

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
        // A stdio server can't reach a url and has nothing to authenticate to — clear
        // every http-only field so a transport flip can't leave a live token behind.
        delete entry.url;
        delete entry.headers;
        delete entry.auth;
        delete entry.bearerToken;
        delete entry.bearerTokenEnv;
        delete entry.oauth;
        if (!entry.command) return { ok: false, message: "A local (stdio) connector needs a command." };
      } else {
        if (draft.url !== undefined) entry.url = String(draft.url).trim();
        // `auth` is authoritative; the legacy boolean is honoured only when it isn't
        // sent, so an old app build keeps working without being able to override.
        if (draft.auth !== undefined) entry.auth = draft.auth;
        else if (draft.oauth !== undefined) entry.auth = draft.oauth ? "oauth" : "none";
        if (draft.bearerTokenEnv !== undefined) {
          const v = String(draft.bearerTokenEnv).trim();
          if (v) entry.bearerTokenEnv = v;
          else delete entry.bearerTokenEnv;
        }
        if (draft.bearerToken !== undefined) {
          const v = String(draft.bearerToken);
          if (v.length > 0) entry.bearerToken = v;
          else delete entry.bearerToken;
        }
        if (draft.headers !== undefined) {
          const merged = mergeSecrets(prev.headers, draft.headers);
          if (merged) entry.headers = merged;
          else delete entry.headers;
        }
        // A token that arrived without an explicit `auth` means bearer — otherwise the
        // adapter stores the token and never sends it (it only sets the Authorization
        // header when auth === "bearer"), which reads to the user as "my token is
        // saved and the connector still 401s".
        if (draft.auth === undefined && (entry.bearerToken || entry.bearerTokenEnv)) entry.auth = "bearer";
        // Once `auth` is set, the legacy boolean is noise that authOf would have to
        // keep tie-breaking. Drop it.
        if (entry.auth !== undefined) delete entry.oauth;
        delete entry.command;
        delete entry.args;
        if (!entry.url) return { ok: false, message: "A remote (http) connector needs a URL." };
        if (authOf(entry, "http") === "bearer" && !entry.bearerToken && !entry.bearerTokenEnv)
          return { ok: false, message: "A bearer connector needs a token, or the name of an env var holding one." };
      }

      // Env/secrets: a present, non-empty value overwrites; an omitted key keeps the
      // existing value (re-save without re-typing the token preserves it). An explicit
      // empty string clears that key.
      if (draft.env !== undefined) {
        const merged = mergeSecrets(prev.env, draft.env);
        if (merged) entry.env = merged;
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

// MCP draft fields whose VALUES are credentials. They ride a sealed box addressed to
// the terminal and are refused anywhere else. `bearerTokenEnv` is deliberately absent:
// it is a variable NAME, not a value, and travels in the clear.
const MCP_SEALED_FIELDS = ["env", "headers", "bearerToken"] as const;

/**
 * Apply the sealed half of an MCP connector save to the plain draft.
 *
 * Credential-bearing fields may ONLY arrive in the sealed box. A signed frame proves
 * the account authored it; it does not stop the relay from READING it, and a bearer
 * token or an `Authorization` header in the clear on the wire is exactly what sealing
 * exists to prevent. We refuse rather than strip: silently dropping a token looks, to
 * the user, like a save that worked.
 *
 * An absent field in the box means "leave what is stored alone" (mcpControl's
 * re-save-without-re-typing rule) — which is not the same as an empty object.
 *
 * Lives here rather than in the harbor so it stays Pi-free and testable: importing the
 * harbor pulls in the whole Pi session stack, which must only load after boot.ts.
 * The signature check runs BEFORE this (harbor applyMcpSave).
 */
export function mergeSealedMcpSecrets(
  draft: Record<string, unknown>,
  opened?: { env?: Record<string, string>; headers?: Record<string, string>; bearerToken?: string },
): { ok: true; draft: Record<string, unknown> } | { ok: false; message: string } {
  for (const field of MCP_SEALED_FIELDS) {
    if (draft[field] !== undefined) {
      return {
        ok: false,
        message: `Connector credentials (${field}) must be sealed to this terminal, not sent in the clear.`,
      };
    }
  }
  if (!opened) return { ok: true, draft };
  const merged = { ...draft };
  if (opened.env !== undefined) merged.env = opened.env;
  if (opened.headers !== undefined) merged.headers = opened.headers;
  if (opened.bearerToken !== undefined) merged.bearerToken = opened.bearerToken;
  return { ok: true, draft: merged };
}
