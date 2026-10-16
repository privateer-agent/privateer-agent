/**
 * MCP connector management for the app — the sibling of channelsControl.ts, but for
 * MCP server config rather than messaging channels. It is what lets the phone/web
 * client add, toggle, and remove MCP connectors on a Node HOST it drives over the
 * relay (the harbor today; an interactive terminal by the same shape).
 *
 * The client itself can NEVER run MCP — a browser tab / RN runtime can't spawn a
 * stdio child or hold a server connection. So "serving MCP to phone/web" means MANAGING the
 * config here, on a host that executes it. This control owns that config.
 *
 * SAME FILE MODEL AS THE DESKTOP (treeview/desktop/src/main/mcpService.ts): the
 * source of truth is `${agentDir}/mcp-desktop.json` — every server with an `enabled`
 * flag — and from it we PROJECT the standard `${agentDir}/mcp.json` (enabled servers
 * only, `{mcpServers:{}}` shape) that Pi's built-in MCP support reads. Sharing those two files
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
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { agentDir } from "../config/paths.ts";
import { writeFileAtomic } from "../util/atomicWrite.ts";

export type McpTransport = "stdio" | "http";

/**
 * How an HTTP connector authenticates — our vocabulary, kept in mcp-desktop.json and on
 * the relay, and projected onto Pi's config (see toPiServerEntry). "none" is a server that
 * needs no credential at all (or carries one entirely in custom headers); stdio
 * connectors are always "none".
 */
export type McpAuth = "oauth" | "bearer" | "none";

// One server as stored in the source file (mcp-desktop.json). Mirrors the desktop's
// SourceEntry: the standard server fields plus our auth vocabulary and `enabled` flag.
export interface SourceEntry {
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
  // (Pi's own `oauth` field is an OAuthConfig object, not a boolean).
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
// auto-detect OAuth, which is Pi's own behaviour (sign-in is offered when the server
// answers 401). Only implicit auth defers to custom headers — an entry that carries its
// credential in a header isn't an OAuth connector — while an explicit `auth` from the
// user still wins.
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
  // Re-write mcp.json from mcp-desktop.json. Run once at launch by
  // migrateMcpProjection, for a file an older release wrote in pi-mcp-adapter's format.
  // `adopt`: projection entries to take into mcp-desktop.json first when it lacks them.
  reproject(adopt?: Record<string, unknown>): void;
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

// Pi's server-name rule (core/mcp-servers.js), and an environment variable name.
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isSseUrl(url: string): boolean {
  try {
    return /\/sse\/?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Carry a value written for pi-mcp-adapter into Pi's config-value syntax, meaning
 * exactly what it meant before.
 *
 * Every value here — env, headers, a bearer token — was typed for the adapter, and
 * the app, /connect and the desktop all still write that vocabulary:
 *   • `${VAR}`, `$env:VAR` and `{env:VAR}` read the environment; any other `$` is a
 *     literal `$`.
 *   • A leading `!` runs the rest as a shell command; `!!` is a literal `!`.
 * Pi (core/resolve-config-value.js) reads `${VAR}` and also bare `$VAR`, runs a
 * leading `!`, and escapes with `$$` and `$!`. So the references become `${VAR}`,
 * every other `$` is doubled (a token like `pa$word` would otherwise lose `$word`),
 * and `!!x` becomes `$!x`. A `!command` stays a command, as it was.
 *
 * One difference stays: an unset variable was "" for the adapter, and makes Pi report
 * the server as misconfigured — a louder failure for the same broken config.
 */
export function toPiConfigValue(value: string): string {
  // "!!x" is a literal "!" then x, with x's references still read (never a command).
  if (value.startsWith("!!")) return `$!${references(value.slice(2))}`;
  if (value.startsWith("!")) return value;
  return references(value);
}

// The adapter's three reference forms as Pi's `${VAR}`; every other `$` literal.
function references(value: string): string {
  const literal = (text: string) => text.replace(/\$/g, "$$$$");
  let out = "";
  let last = 0;
  for (const m of value.matchAll(/\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g)) {
    out += literal(value.slice(last, m.index)) + "${" + (m[1] ?? m[2] ?? m[3]) + "}";
    last = m.index! + m[0].length;
  }
  return out + literal(value.slice(last));
}

function piConfigValues(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) out[k] = toPiConfigValue(String(v ?? ""));
  return out;
}

/**
 * A bearer token as a whole Authorization header value. A command token (`!cmd`)
 * printed only the token for the adapter, which added "Bearer "; Pi runs a command
 * only as the WHOLE value, so the prefix moves inside it.
 */
function bearerHeader(token: string): string {
  if (token.startsWith("!") && !token.startsWith("!!")) return `!printf 'Bearer %s' "$(${token.slice(1)})"`;
  return `Bearer ${toPiConfigValue(token)}`;
}

/**
 * One-time upgrade of a projection written for pi-mcp-adapter. Its marker is the
 * `settings.toolPrefix` pin every earlier release wrote; such a file carries `auth`
 * strings and `bearerToken` fields that Pi rejects, so every HTTP connector in it would
 * vanish. Re-projecting from mcp-desktop.json rewrites it in Pi's format. A file
 * without the marker — Pi's own, or hand-written — is left alone.
 */
export function migrateMcpProjection(dir: () => string = agentDir): boolean {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(join(dir(), "mcp.json"), "utf8"));
    if (raw?.settings?.toolPrefix === undefined) return false;
  } catch {
    return false;
  }
  // A server someone added to mcp.json by hand never reached mcp-desktop.json, and
  // re-projecting from that file alone would drop it. Adopt those first.
  makeMcpControl({ dir }).reproject(raw?.mcpServers ?? {});
  return true;
}

// Legacy SSE endpoints of servers that also serve streamable HTTP, which is all Pi
// speaks. A connector saved with one of these (the catalog shipped them) is moved to
// the streamable URL wherever it is projected, so it keeps working without a re-save.
const LEGACY_SSE_URLS: Record<string, string> = {
  "https://mcp.atlassian.com/v1/sse": "https://mcp.atlassian.com/v1/mcp",
  "https://mcp.asana.com/sse": "https://mcp.asana.com/mcp",
  "https://mcp.linear.app/sse": "https://mcp.linear.app/mcp",
};

export function upgradeLegacyUrl(url: string): string {
  return LEGACY_SSE_URLS[url.replace(/\/$/, "")] ?? url;
}

// One managed entry as a Pi `mcpServers` entry. Exported for the desktop's connector
// manager (treeview desktop/src/main/mcpService.ts), which writes the same files and
// must write them the same way. Built field by field rather than
// spread, because our vocabulary and Pi's differ:
//
//   • Pi has no bearer field. A static token becomes an `Authorization` header, and a
//     token read from the environment becomes "Bearer ${VAR}". A header named
//     Authorization is also what tells Pi NOT to start OAuth for the server.
//   • Pi's `auth` is `{ provider }` — a Pi /login provider's token — not our
//     "oauth" | "bearer" | "none". Any other value makes Pi reject the whole entry, so
//     ours never reaches the file. OAuth needs no field at all: Pi offers sign-in when
//     a server without an Authorization header answers 401.
//   • Pi and the adapter both expand env and header values, with different syntax:
//     each value is carried over so it means what it meant (toPiConfigValue). Copied
//     verbatim, a token containing "$" would be mangled by Pi's bare-$VAR rule.
export function toPiServerEntry(e: SourceEntry): Record<string, unknown> {
  const transport: McpTransport = e.transport ?? (e.url ? "http" : "stdio");
  const std: Record<string, unknown> = {};
  if (transport === "stdio") {
    if (e.command) std.command = e.command;
    if (e.args?.length) std.args = e.args;
    if (e.env && Object.keys(e.env).length > 0) std.env = piConfigValues(e.env);
  } else {
    if (e.url) std.url = upgradeLegacyUrl(e.url);
    const headers: Record<string, string> = piConfigValues(e.headers ?? {});
    if (authOf(e, transport) === "bearer") {
      // A stored token wins over the env var name.
      if (e.bearerToken) headers.Authorization = bearerHeader(e.bearerToken);
      else if (e.bearerTokenEnv && ENV_NAME.test(e.bearerTokenEnv)) headers.Authorization = `Bearer \${${e.bearerTokenEnv}}`;
    }
    if (Object.keys(headers).length > 0) std.headers = headers;
  }
  return std;
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
    writeFileAtomic(sourcePath(), JSON.stringify(src, null, 2) + "\n");
    project(src);
  }

  // Project the servers into the standard mcp.json Pi reads. An entry with no
  // explicit transport is treated as stdio if it has a command, http if it has a url —
  // matching Pi's own inference.
  //
  // A disabled server is written with Pi's own `enabled: false` rather than left out:
  // Pi keeps it listed (and skips connecting it), and `mcp login` can still find it —
  // a desktop window may activate a connector that is off by default and need to sign
  // in to it.
  function project(src: SourceFile): void {
    const mcpServers: Record<string, unknown> = {};
    for (const [name, e] of Object.entries(src.servers)) {
      mcpServers[name] = e.enabled === false ? { ...toPiServerEntry(e), enabled: false } : toPiServerEntry(e);
    }
    mkdirSync(dirname(projectionPath()), { recursive: true });
    writeFileAtomic(projectionPath(), JSON.stringify({ mcpServers }, null, 2) + "\n");
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
    reproject(adopt?: Record<string, unknown>): void {
      const src = readSource();
      let added = false;
      for (const [name, entry] of Object.entries(adopt ?? {})) {
        if (src.servers[name] || !entry || typeof entry !== "object") continue;
        src.servers[name] = { ...(entry as SourceEntry), enabled: true };
        added = true;
      }
      if (added) writeSource(src);
      else project(src);
    },

    list(): RemoteMcpServer[] {
      const src = readSource();
      return Object.entries(src.servers).map(([name, e]) => toRemote(name, e));
    },

    save(draft: McpDraft): { ok: boolean; message?: string } {
      const name = String(draft?.name ?? "").trim();
      if (!name) return { ok: false, message: "A connector needs a name." };
      // Pi's rule for server names; anything else is skipped as invalid at connect time.
      if (!SERVER_NAME.test(name))
        return { ok: false, message: "A connector name may use only letters, digits, \"-\" and \"_\"." };
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
        // A connector saved with a legacy SSE endpoint before Pi: move it on, rather
        // than refuse every later edit of it below.
        if (entry.url) entry.url = upgradeLegacyUrl(entry.url);
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
        // token is stored and never projected into an Authorization header (toPiServerEntry
        // only sends it for bearer), which reads to the user as "my token is saved and
        // the connector still 401s".
        if (draft.auth === undefined && (entry.bearerToken || entry.bearerTokenEnv)) entry.auth = "bearer";
        // Once `auth` is set, the legacy boolean is noise that authOf would have to
        // keep tie-breaking. Drop it.
        if (entry.auth !== undefined) delete entry.oauth;
        delete entry.command;
        delete entry.args;
        if (!entry.url) return { ok: false, message: "A remote (http) connector needs a URL." };
        // Pi speaks streamable HTTP only. An SSE endpoint would save and then fail on
        // every connect, so say so now — most servers serve streamable HTTP at /mcp.
        if (isSseUrl(entry.url))
          return {
            ok: false,
            message: "That looks like a legacy SSE endpoint, which isn't supported. Use the server's streamable HTTP URL (often ending in /mcp).",
          };
        if (entry.bearerTokenEnv && !ENV_NAME.test(entry.bearerTokenEnv))
          return { ok: false, message: "The token variable must be an environment variable name, like GITHUB_TOKEN." };
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
