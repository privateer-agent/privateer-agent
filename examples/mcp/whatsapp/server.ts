import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { WhatsAppBackend } from "./backends/types.ts";
import { cloudBackend } from "./backends/cloud.ts";
import { twilioBackend } from "./backends/twilio.ts";

// MCP stdio server that sends WhatsApp messages. Both tools declare
// destructiveHint — sending a message is irreversible egress — so in interactive
// Privateer sessions they always prompt; in daemon routine runs the grant happens
// once, at routine creation. Backend chosen by WHATSAPP_BACKEND=cloud|twilio
// (default cloud); see backends/*.ts for each backend's env vars.

const backends: Record<string, WhatsAppBackend> = { cloud: cloudBackend, twilio: twilioBackend };
const backendName = process.env.WHATSAPP_BACKEND ?? "cloud";
const backend = backends[backendName];
if (!backend) throw new Error(`unknown WHATSAPP_BACKEND "${backendName}" (expected cloud or twilio)`);

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (err: unknown) => ({
  content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

const server = new McpServer({ name: "whatsapp", version: "0.1.0" });

server.registerTool(
  "send_template",
  {
    description:
      "Send a pre-approved WhatsApp template message. Required for business-initiated " +
      "conversations. `to` is E.164 ('+15551234567'); `variables` fill the template body " +
      "placeholders in order. With the twilio backend, `template` is a ContentSid.",
    inputSchema: {
      to: z.string(),
      template: z.string(),
      language: z.string().default("en"),
      variables: z.array(z.string()).default([]),
    },
    annotations: { destructiveHint: true },
  },
  async ({ to, template, language, variables }) => {
    try {
      const id = await backend.sendTemplate(to, template, language, variables);
      return ok(`sent template "${template}" to ${to} (${id})`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "send_text",
  {
    description:
      "Send a free-form WhatsApp text. Only deliverable inside a 24h customer-service window " +
      "(after the recipient last messaged the business); use send_template otherwise.",
    inputSchema: { to: z.string(), body: z.string() },
    annotations: { destructiveHint: true },
  },
  async ({ to, body }) => {
    try {
      const id = await backend.sendText(to, body);
      return ok(`sent text to ${to} (${id})`);
    } catch (err) {
      return fail(err);
    }
  },
);

await server.connect(new StdioServerTransport());
