/**
 * Curated MCP connector catalog for the `/connect` TUI picker — the terminal's
 * counterpart to the app's quick-add grid (treeview/client/components/mcpCatalog.ts).
 * Kept in sync with that list by hand: it is small, changes rarely, and duplicating
 * eight entries is cheaper than making the agent depend on the client package.
 *
 * `needs` drives what the wizard asks for after you pick an entry:
 *   token — one prompt per env key (masked); `credUrl` is shown as "get one at …"
 *   path  — one prompt replacing the `fill` placeholder ARG (a folder, a DSN)
 *   oauth — nothing to type here; you authorize in a browser on THIS machine
 *   url   — one prompt to confirm the endpoint of a server already running HERE
 *   none  — runs locally with no credentials, save it as-is
 *
 * Keep this list conservative and correct: a broken command in the catalog is worse
 * than an omission — the user has no way to tell "this server is misconfigured" from
 * "MCP is broken". tests/mcpCatalog.test.ts enforces the structural invariants.
 */
import type { McpDraft, McpTransport } from "../remote/mcpControl.ts";

export type CatalogNeeds = "token" | "path" | "oauth" | "url" | "none";

export interface CatalogEntry {
  // Stable key for the picker; also the default server name written to config.
  id: string;
  name: string;
  label: string; // display name in the picker
  blurb: string; // one line, lowercase-ish, says what it gives the agent
  transport: McpTransport;
  command?: string; // stdio
  args?: string[]; // stdio
  env?: Record<string, string>; // env KEYS the user must fill (values are "")
  url?: string; // http
  oauth?: boolean; // http servers that negotiate OAuth
  needs: CatalogNeeds;
  // needs:"token" → the PRIMARY env key (others are still prompted for).
  // needs:"path"  → the placeholder ARG to replace with a real path/DSN.
  fill?: string;
  // Where to get the credential, shown as a hint in the form.
  credUrl?: string;
  /**
   * An HTTP server running on THIS MACHINE that needs no credential at all.
   *
   * A third shape alongside `oauth` and a stored bearer token, and it needs its own
   * flag rather than falling out of the URL: every other http entry here is a remote
   * service the user authorizes, so "must authenticate" is derived from
   * `transport === "http"` alone. That is false here — there is nothing to authorize
   * — so the flag is what makes draftFromCatalog emit `auth: "none"`. Without it the
   * adapter goes hunting for an authorization server that does not exist.
   *
   * Always pair with `hosted: false`: a hosted enclave has no route to the user's
   * loopback, and hostedCapable()'s derived rule keys on `oauth`, not on this.
   */
  localHttp?: boolean;
  /**
   * Where to learn how to TURN THE SERVER ON — deliberately not `credUrl`, which
   * means "get a credential here" and would be a lie for an entry that has none.
   */
  docsUrl?: string;
  // Can this connector run on a HOSTED (Harbor) agent? Leave unset to take the derived
  // answer from hostedCapable() below; set it explicitly only to say "no" to something
  // that would otherwise qualify.
  hosted?: boolean;
}

/**
 * Whether an entry can run on a hosted agent, as opposed to a local daemon/desktop.
 *
 * The rule is not a preference, it is the runtime: a Harbor tenant is `--read-only`,
 * `--cap-drop ALL`, has no `uv`/`uvx`/Python/browser, and its home is tmpfs wiped on
 * every suspend. A stdio entry would have to download and execute unmeasured
 * third-party code inside an attested enclave at runtime, which defeats the point of
 * the measurement; and a token-bearing entry would need a durable secret at rest,
 * which we decided against (Option B — see treeview/docs/HARBOR_CONNECTORS_PLAN.md §2).
 * What is left is remote HTTP + OAuth.
 *
 * The `/connect` picker filters on this (extensions/privateer-connect.ts →
 * catalogRows) rather than showing 21 options of which 16 cannot work. It shapes the
 * custom-connector form there too: no local command, no stored token.
 *
 * It does NOT gate mcpControl.save() — the app-over-relay path can still write a
 * connector this returns false for. Fixing that means teaching mcpControl about
 * hosted mode, which is a bigger change than a picker filter.
 */
export function hostedCapable(e: CatalogEntry): boolean {
  if (e.hosted !== undefined) return e.hosted;
  return e.transport === "http" && e.oauth === true;
}

export const MCP_CATALOG: CatalogEntry[] = [
  {
    id: "github",
    name: "github",
    label: "GitHub",
    blurb: "Repos, issues, and pull requests.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    needs: "token",
    fill: "GITHUB_PERSONAL_ACCESS_TOKEN",
    credUrl: "https://github.com/settings/tokens",
  },
  {
    id: "filesystem",
    name: "filesystem",
    label: "Filesystem",
    blurb: "Read and write files in a folder you pick.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/folder"],
    needs: "path",
    fill: "/path/to/folder",
  },
  {
    id: "notion",
    name: "notion",
    label: "Notion",
    blurb: "Pages, databases, and blocks.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    env: { NOTION_TOKEN: "" },
    needs: "token",
    fill: "NOTION_TOKEN",
    credUrl: "https://www.notion.so/my-integrations",
  },
  {
    id: "linear",
    name: "linear",
    label: "Linear",
    blurb: "Issues and projects. Sign in via browser.",
    transport: "http",
    // /sse is GONE — it 404s on both GET and POST (checked 2026-07-31). Linear moved
    // to the Streamable HTTP endpoint; the old URL silently failed for anyone who
    // added Linear from this picker. Mirrored from the client copy on 2026-08-06.
    url: "https://mcp.linear.app/mcp",
    oauth: true,
    needs: "oauth",
  },
  {
    id: "slack",
    name: "slack",
    label: "Slack",
    blurb: "Read and post to channels.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" },
    needs: "token",
    fill: "SLACK_BOT_TOKEN",
    credUrl: "https://api.slack.com/apps",
  },
  {
    id: "postgres",
    name: "postgres",
    label: "PostgreSQL",
    blurb: "Query a Postgres database (read-only).",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
    needs: "path",
    fill: "postgresql://localhost/mydb",
  },
  {
    id: "playwright",
    name: "playwright",
    label: "Browser (Playwright)",
    blurb: "Drive a real browser to fetch and click.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    needs: "none",
  },
  {
    id: "memory",
    name: "memory",
    label: "Memory",
    blurb: "A local knowledge-graph scratchpad.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    needs: "none",
  },

  // ── Remote, browser-authorized (OAuth) ──────────────────────────────────────
  {
    id: "sentry",
    name: "sentry",
    label: "Sentry",
    blurb: "Errors, issues, and releases. Sign in via browser.",
    transport: "http",
    url: "https://mcp.sentry.dev/mcp",
    oauth: true,
    needs: "oauth",
  },
  {
    id: "atlassian",
    name: "atlassian",
    label: "Jira & Confluence",
    blurb: "Atlassian issues and pages. Sign in via browser.",
    transport: "http",
    url: "https://mcp.atlassian.com/v1/sse",
    oauth: true,
    needs: "oauth",
  },
  {
    id: "stripe",
    name: "stripe",
    label: "Stripe",
    blurb: "Payments, customers, and invoices. Sign in via browser.",
    transport: "http",
    url: "https://mcp.stripe.com",
    oauth: true,
    needs: "oauth",
  },
  {
    id: "asana",
    name: "asana",
    label: "Asana",
    blurb: "Tasks and projects. Sign in via browser.",
    transport: "http",
    url: "https://mcp.asana.com/sse",
    oauth: true,
    needs: "oauth",
  },

  // ── Local, token-authorized ─────────────────────────────────────────────────
  {
    id: "brave-search",
    name: "brave-search",
    label: "Brave Search",
    blurb: "Web and local search results.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { BRAVE_API_KEY: "" },
    needs: "token",
    fill: "BRAVE_API_KEY",
    credUrl: "https://brave.com/search/api/",
  },
  {
    id: "google-maps",
    name: "google-maps",
    label: "Google Maps",
    blurb: "Places, directions, and geocoding.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-google-maps"],
    env: { GOOGLE_MAPS_API_KEY: "" },
    needs: "token",
    fill: "GOOGLE_MAPS_API_KEY",
    credUrl: "https://console.cloud.google.com/google/maps-apis/credentials",
  },
  {
    id: "supabase",
    name: "supabase",
    label: "Supabase",
    blurb: "Query and manage your Supabase project.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@supabase/mcp-server-supabase@latest"],
    env: { SUPABASE_ACCESS_TOKEN: "" },
    needs: "token",
    fill: "SUPABASE_ACCESS_TOKEN",
    credUrl: "https://supabase.com/dashboard/account/tokens",
  },
  {
    id: "figma",
    name: "figma",
    label: "Figma",
    blurb: "Read designs, frames, and components.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "figma-developer-mcp", "--stdio"],
    env: { FIGMA_API_KEY: "" },
    needs: "token",
    fill: "FIGMA_API_KEY",
    credUrl: "https://www.figma.com/developers/api#access-tokens",
  },
  // ── Google Workspace (needs a Google Cloud OAuth client, then browser sign-in) ─
  // One server (workspace-mcp) scoped per service via --tools. Runs on uv (uvx),
  // not npx. Create an OAuth client in Google Cloud once and paste its ID + secret;
  // the first request opens Google's consent screen on THIS machine.
  {
    id: "gmail",
    name: "gmail",
    label: "Gmail",
    blurb: "Read, search, and send email. Google sign-in.",
    transport: "stdio",
    command: "uvx",
    args: ["workspace-mcp", "--tools", "gmail"],
    env: { GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "" },
    needs: "token",
    fill: "GOOGLE_OAUTH_CLIENT_ID",
    credUrl: "https://console.cloud.google.com/apis/credentials",
  },
  {
    id: "google-calendar",
    name: "google-calendar",
    label: "Google Calendar",
    blurb: "Events and scheduling. Google sign-in.",
    transport: "stdio",
    command: "uvx",
    args: ["workspace-mcp", "--tools", "calendar"],
    env: { GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "" },
    needs: "token",
    fill: "GOOGLE_OAUTH_CLIENT_ID",
    credUrl: "https://console.cloud.google.com/apis/credentials",
  },
  {
    id: "google-drive",
    name: "google-drive",
    label: "Google Drive",
    blurb: "Files and folders in your Drive. Google sign-in.",
    transport: "stdio",
    command: "uvx",
    args: ["workspace-mcp", "--tools", "drive"],
    env: { GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "" },
    needs: "token",
    fill: "GOOGLE_OAUTH_CLIENT_ID",
    credUrl: "https://console.cloud.google.com/apis/credentials",
  },
  {
    id: "google-docs",
    name: "google-docs",
    label: "Google Docs",
    blurb: "Read and edit your documents. Google sign-in.",
    transport: "stdio",
    command: "uvx",
    args: ["workspace-mcp", "--tools", "docs"],
    env: { GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "" },
    needs: "token",
    fill: "GOOGLE_OAUTH_CLIENT_ID",
    credUrl: "https://console.cloud.google.com/apis/credentials",
  },
  {
    id: "sequential-thinking",
    name: "sequential-thinking",
    label: "Sequential Thinking",
    blurb: "A step-by-step reasoning scratchpad.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    needs: "none",
  },

  // ── Local apps that host their own MCP server ───────────────────────────────
  // http, but on 127.0.0.1: nothing to install, nothing to authorize, nothing
  // leaving the machine. See `localHttp` on CatalogEntry for why that needs a flag.
  {
    // Unreal Engine 5.8 embeds an MCP server in the EDITOR PROCESS (plugin
    // `ModelContextProtocol`, surfaced as "Unreal MCP"; the tools come from the
    // "All Toolsets" plugin, which has to be enabled too). Three facts shape this:
    //
    //  1. NO AUTHENTICATION, of any kind. Hence localHttp + auth:"none".
    //  2. LOOPBACK ONLY. It binds per [HTTPServer.Listeners] DefaultBindAddress
    //     (default `localhost`) AND rejects non-loopback `Origin` headers — so the
    //     agent has to be on the same machine as the editor. True for this CLI and
    //     for the desktop app; not true for a hosted agent, hence hosted: false.
    //  3. IT IS ONLY UP WHILE THE EDITOR IS. A connector that fails here usually
    //     means "Unreal isn't running", not "this is misconfigured".
    //
    // The port and path are editable in Editor Preferences → Model Context
    // Protocol, so `needs: "url"`: the one setup step is confirming the endpoint
    // rather than pasting a secret. `ModelContextProtocol.GenerateClientConfig` in
    // the UE console prints the URL the editor is actually serving.
    id: "unreal",
    name: "unreal",
    label: "Unreal Engine",
    blurb: "Drive the Unreal Editor — actors, lighting, materials, tests.",
    transport: "http",
    url: "http://127.0.0.1:8000/mcp",
    localHttp: true,
    needs: "url",
    hosted: false,
    docsUrl: "https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor",
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

// The env keys the wizard prompts for, primary (`fill`) first so the token you
// actually care about is asked for before the incidentals (Slack's TEAM_ID).
export function promptOrder(e: CatalogEntry): string[] {
  const keys = Object.keys(e.env ?? {});
  if (!e.fill || !keys.includes(e.fill)) return keys;
  return [e.fill, ...keys.filter((k) => k !== e.fill)];
}

// Build the draft mcpControl.save() persists, from a catalog entry plus whatever the
// user typed. PURE — the whole reason this lives outside the TUI component.
//
//   input.env  — env VALUES by key. An empty/omitted value is passed through as ""
//                and mcpControl treats that as "clear this key" — so a skipped
//                optional credential is simply absent, never a bogus empty one.
//   input.fill — the real path/DSN replacing the placeholder ARG (needs:"path").
//   input.url  — the endpoint the user confirmed (needs:"url"); blank keeps the
//                catalog default, so a straight <enter> is the documented port.
export function draftFromCatalog(
  e: CatalogEntry,
  input: { env?: Record<string, string>; fill?: string; url?: string } = {},
): McpDraft {
  const draft: McpDraft = { name: e.name, transport: e.transport };

  if (e.transport === "stdio") {
    draft.command = e.command;
    // Replace the placeholder ARG in place (not by index) so reordering the catalog's
    // args can never silently overwrite the wrong one.
    const filled = input.fill?.trim();
    draft.args = (e.args ?? []).map((a) => (e.fill && a === e.fill && filled ? filled : a));
  } else {
    draft.url = input.url?.trim() || e.url;
    // Emit the adapter's own vocabulary (`auth`) rather than the legacy boolean, so
    // the projection carries a string and not a bogus boolean in the adapter's
    // OAuthConfig slot. A localHttp entry authenticates to nothing — saying "oauth"
    // there would send the adapter looking for an authorization server that does not
    // exist, which fails at connect time rather than at save time.
    draft.auth = e.localHttp ? "none" : (e.oauth ?? true) ? "oauth" : "none";
  }

  const keys = Object.keys(e.env ?? {});
  if (keys.length > 0) {
    const env: Record<string, string> = {};
    for (const k of keys) env[k] = input.env?.[k] ?? "";
    draft.env = env;
  }
  return draft;
}
