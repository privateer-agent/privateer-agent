// A WhatsApp delivery backend. `to` is an E.164 phone number ("+15551234567").
// Both methods resolve to a provider message id, or throw with the provider's
// error text (the server surfaces it as an isError tool result).
export interface WhatsAppBackend {
  // Send a pre-approved template. `variables` fill the template's body
  // placeholders {{1}}, {{2}}, ... in order.
  sendTemplate(to: string, template: string, language: string, variables: string[]): Promise<string>;
  // Free-form text — deliverable only inside a 24h customer-service window
  // (i.e. after the recipient last messaged the business).
  sendText(to: string, body: string): Promise<string>;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
