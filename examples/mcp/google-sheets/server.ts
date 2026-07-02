import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { accessToken } from "./auth.ts";

// MCP stdio server exposing a Google Sheet to Privateer. Pair it with the
// sheet-to-whatsapp recipe: `get_rows` reads the range, `update_cell` writes the
// per-row "Notified" marker. Failures are returned as tool results (isError) —
// Privateer ignores MCP server stderr, so nothing may be reported there.
//
// Env: GOOGLE_SERVICE_ACCOUNT_FILE — path to a service-account key JSON; share the
// spreadsheet with the service account's email (editor role for writes).

const API = "https://sheets.googleapis.com/v4/spreadsheets";

async function sheets(path: string, init?: RequestInit): Promise<any> {
  const token = await accessToken();
  const res = await fetch(`${API}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${await res.text()}`);
  return res.json();
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

const server = new McpServer({ name: "google-sheets", version: "0.1.0" });

server.registerTool(
  "get_rows",
  {
    description:
      "Read cell values from a spreadsheet range in A1 notation (e.g. 'Clients!A2:H'). " +
      "Returns a JSON array of rows; trailing empty cells are omitted per row.",
    inputSchema: { spreadsheetId: z.string(), range: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ spreadsheetId, range }) => {
    try {
      const data = await sheets(`${spreadsheetId}/values/${encodeURIComponent(range)}`);
      return ok(JSON.stringify(data.values ?? []));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "update_cell",
  {
    description: "Write one cell, addressed in A1 notation (e.g. 'Clients!H5'). Value is written as-is (RAW).",
    inputSchema: { spreadsheetId: z.string(), cell: z.string(), value: z.string() },
  },
  async ({ spreadsheetId, cell, value }) => {
    try {
      await sheets(`${spreadsheetId}/values/${encodeURIComponent(cell)}?valueInputOption=RAW`, {
        method: "PUT",
        body: JSON.stringify({ values: [[value]] }),
      });
      return ok(`updated ${cell}`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "append_row",
  {
    description:
      "Append a row after the last row of data in the given table range (e.g. 'Clients!A:H'). " +
      "Values are parsed as if typed by a user (USER_ENTERED).",
    inputSchema: { spreadsheetId: z.string(), range: z.string(), values: z.array(z.string()) },
  },
  async ({ spreadsheetId, range, values }) => {
    try {
      const data = await sheets(
        `${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`,
        { method: "POST", body: JSON.stringify({ values: [values] }) },
      );
      return ok(`appended at ${data.updates?.updatedRange ?? range}`);
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
