import { type WhatsAppBackend, requireEnv } from "./types.ts";

// Meta's WhatsApp Business Cloud API (graph.facebook.com). Env:
//   WHATSAPP_TOKEN           — permanent system-user access token
//   WHATSAPP_PHONE_NUMBER_ID — the business phone number id (not the number itself)

const GRAPH = "https://graph.facebook.com/v20.0";

async function post(payload: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${GRAPH}/${requireEnv("WHATSAPP_PHONE_NUMBER_ID")}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${requireEnv("WHATSAPP_TOKEN")}`, "content-type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`WhatsApp Cloud API ${res.status}: ${text}`);
  return (JSON.parse(text)?.messages?.[0]?.id as string) ?? "(no message id)";
}

export const cloudBackend: WhatsAppBackend = {
  sendTemplate(to, template, language, variables) {
    return post({
      to,
      type: "template",
      template: {
        name: template,
        language: { code: language },
        components:
          variables.length > 0
            ? [{ type: "body", parameters: variables.map((v) => ({ type: "text", text: v })) }]
            : undefined,
      },
    });
  },
  sendText(to, body) {
    return post({ to, type: "text", text: { body } });
  },
};
