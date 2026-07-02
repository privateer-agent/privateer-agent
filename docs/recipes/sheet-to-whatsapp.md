# Recipe: Google Sheet → WhatsApp notifier

A recurring routine that watches a manually-updated spreadsheet, and for every new row
sends a WhatsApp message to the phone number in that row. Built from three pieces:

- the **routines daemon** (`privateer daemon`) — runs the check on a cron schedule,
- the **google-sheets** example MCP server — reads rows and writes the `Notified` marker,
- the **whatsapp** example MCP server — sends the message (Meta Cloud API or Twilio).

The sheet itself is the state store: a `Notified` column marks which rows have been
messaged, so runs are idempotent, restarts are safe, and a human can see (or reset) the
status at a glance.

## 0. Prerequisites

- An **always-on machine** (Mac mini, VPS, ...). The daemon only fires routines while it's
  running: `privateer daemon --detach`, ideally under launchd/systemd so it survives reboots.
- Node ≥ 20 and a Privateer checkout (the example servers live in `examples/mcp/`).
- Install the example servers' deps once: `npm install` inside
  `examples/mcp/google-sheets/` and `examples/mcp/whatsapp/`. Don't rely on `npx` fetching
  at run time — MCP connects have a 10s timeout.
- If the source file is a real `.xlsx` in Drive, convert it once: open in Google Sheets →
  **File → Save as Google Sheets**, and have the owner edit that copy from now on. The
  Sheets API gives us per-cell writes for the `Notified` marker; a raw `.xlsx` would force
  whole-file re-uploads that race the owner's manual edits.

## 1. Google side

1. In Google Cloud Console: create (or pick) a project → enable the **Google Sheets API**.
2. Create a **service account**; download its key JSON to the daemon machine, e.g.
   `/opt/client-agent/sa.json` (chmod 600).
3. Share the spreadsheet with the service account's email address (**Editor** — it writes
   the `Notified` column).
4. In the sheet, add a header column named `Notified` (say column **H**), left empty for
   new rows.
5. Note the spreadsheet id (the long segment in its URL).

## 2. WhatsApp side

Business-initiated WhatsApp messages **must use a pre-approved template** — free-form text
only works inside a 24h window after the customer last wrote to you.

**Meta Cloud API (default backend):** in the Meta developer console, create a WhatsApp
Business app; register the sending phone number and note its **phone number id**; create a
**system user** with a permanent access token; create a message template (e.g.
`welcome_client`, body: `Hi {{1}}, thanks for signing up! ...`) and wait for approval.

**Twilio (alternative):** set `WHATSAPP_BACKEND=twilio`; `template` then takes a Content
SID (`HX...`) and the envs are `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_WHATSAPP_FROM`.

## 3. Wire the MCP servers

In the project the routine will run from (its `cwd`), create `.privateer/mcp.json` and
**chmod 600** it — it holds the WhatsApp token. Values are literal (no `$VAR` expansion),
and a detached daemon may not have your shell's environment, so put credentials here or in
files referenced by absolute path:

```json
{
  "mcpServers": {
    "sheets": {
      "command": "node",
      "args": ["--import", "tsx", "/opt/privateer/examples/mcp/google-sheets/server.ts"],
      "env": { "GOOGLE_SERVICE_ACCOUNT_FILE": "/opt/client-agent/sa.json" }
    },
    "whatsapp": {
      "command": "node",
      "args": ["--import", "tsx", "/opt/privateer/examples/mcp/whatsapp/server.ts"],
      "env": {
        "WHATSAPP_BACKEND": "cloud",
        "WHATSAPP_TOKEN": "…",
        "WHATSAPP_PHONE_NUMBER_ID": "…"
      }
    }
  }
}
```

`/mcp` in an interactive session should now show both servers with their tools
(`sheets__get_rows`, `sheets__update_cell`, `whatsapp__send_template`, ...).

## 4. Create the routine

Ask the agent (in the project directory) for something like:

> Every 5 minutes, check the Clients sheet for new rows and send each new client the
> welcome template on WhatsApp.

and steer it to a routine equivalent to:

```json
{
  "name": "welcome-new-clients",
  "cron": "*/5 * * * *",
  "delivery": ["file", "notice"],
  "tools": ["sheets__get_rows", "sheets__update_cell", "whatsapp__send_template"],
  "prompt": "Fetch range 'Clients!A2:H' of spreadsheet <SPREADSHEET_ID> with sheets__get_rows. Columns: A=name, C=phone, H=Notified. For each row, top to bottom, at most 10 per run, where C has a phone and H is empty: (1) send WhatsApp template 'welcome_client' (language 'en', variable 1 = the name in A) to the phone in E.164 form via whatsapp__send_template; (2) immediately set that row's H cell to the current ISO timestamp via sheets__update_cell before moving to the next row. If a send fails, leave H empty and note the failure. Finish with one line: rows scanned / sent / failed."
}
```

The `tools` grant is the security decision: those MCP tools run **unattended, with no
approval prompts**, so the approval dialog flags it
(`[grants external MCP tools, unattended: …]`) and always asks, even in bypass mode.
Grant only the tools the task needs — e.g. not `whatsapp__send_text`, not `sheets__*`.

Why send-then-mark, one row at a time: if a run dies between the two steps, the worst case
is **one duplicate message** on the next run. Mark-then-send would instead risk silently
never messaging that client.

## 5. Run it

```sh
privateer daemon --detach        # or under launchd/systemd
privateer                         # then: /routine            → see it scheduled
                                  #       /routine run welcome-new-clients   → smoke test
```

Smoke-test with your own number in a test row before pointing it at real clients. Each
run's report lands in `~/.privateer/routines/welcome-new-clients/latest.md` (plus dated
files), and `notice` delivery surfaces a one-line result next time you open Privateer.

## Safety notes

- **Templates only** for new contacts — that's a WhatsApp platform rule, and it also means
  the agent composes nothing free-form; it only fills approved placeholders.
- **Per-run cap** (10 in the prompt above) bounds the blast radius of a bad sheet edit.
- **Restart-safe**: state lives in the sheet's `Notified` column; restarting the daemon or
  moving machines never re-sends old rows.
- **Keep the daemon host's `mcp.json` minimal.** Routine runs auto-approve every tool
  they're granted — including destructive ones — because nobody is watching. The
  per-routine `tools` list is the guardrail; don't hand a routine `whatsapp__*`.
- The routine's own toolset stays the safe read/web set (no shell, no file writes); only
  the explicitly granted MCP tools are added on top.
