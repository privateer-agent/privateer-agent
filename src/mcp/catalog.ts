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
 *   none  — runs locally with no credentials, save it as-is
 *
 * Keep this list conservative and correct: a broken command in the catalog is worse
 * than an omission — the user has no way to tell "this server is misconfigured" from
 * "MCP is broken". tests/mcpCatalog.test.ts enforces the structural invariants.
 */
import type { McpDraft, McpTransport } from "../remote/mcpControl.ts";

export type CatalogNeeds = "token" | "path" | "oauth" | "none";

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
    url: "https://mcp.linear.app/sse",
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
export function draftFromCatalog(
  e: CatalogEntry,
  input: { env?: Record<string, string>; fill?: string } = {},
): McpDraft {
  const draft: McpDraft = { name: e.name, transport: e.transport };

  if (e.transport === "stdio") {
    draft.command = e.command;
    // Replace the placeholder ARG in place (not by index) so reordering the catalog's
    // args can never silently overwrite the wrong one.
    const filled = input.fill?.trim();
    draft.args = (e.args ?? []).map((a) => (e.fill && a === e.fill && filled ? filled : a));
  } else {
    draft.url = e.url;
    draft.oauth = e.oauth ?? true;
  }

  const keys = Object.keys(e.env ?? {});
  if (keys.length > 0) {
    const env: Record<string, string> = {};
    for (const k of keys) env[k] = input.env?.[k] ?? "";
    draft.env = env;
  }
  return draft;
}
