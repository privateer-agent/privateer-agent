import { type WhatsAppBackend, requireEnv } from "./types.ts";

// Twilio's WhatsApp API. Templates are Twilio Content resources, so `template`
// here is a ContentSid (HX...) and `language` is ignored (baked into the content).
// Env:
//   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
//   TWILIO_WHATSAPP_FROM — the approved sender, e.g. "whatsapp:+14155238886"

async function post(form: Record<string, string>): Promise<string> {
  const sid = requireEnv("TWILIO_ACCOUNT_SID");
  const auth = Buffer.from(`${sid}:${requireEnv("TWILIO_AUTH_TOKEN")}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: requireEnv("TWILIO_WHATSAPP_FROM"), ...form }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Twilio API ${res.status}: ${text}`);
  return (JSON.parse(text)?.sid as string) ?? "(no message sid)";
}

export const twilioBackend: WhatsAppBackend = {
  sendTemplate(to, template, _language, variables) {
    return post({
      To: `whatsapp:${to}`,
      ContentSid: template,
      ContentVariables: JSON.stringify(Object.fromEntries(variables.map((v, i) => [String(i + 1), v]))),
    });
  },
  sendText(to, body) {
    return post({ To: `whatsapp:${to}`, Body: body });
  },
};
