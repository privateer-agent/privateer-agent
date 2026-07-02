import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

// Service-account auth without any Google SDK: build the JWT-bearer assertion by
// hand (RS256 over header.claims with the SA private key) and swap it for a
// short-lived access token at the OAuth token endpoint. The token is cached and
// refreshed a minute before expiry.

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

let cached: { token: string; expiresAt: number } | undefined;

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

export async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  if (!file) throw new Error("GOOGLE_SERVICE_ACCOUNT_FILE is not set (path to the service-account key JSON)");
  const sa = JSON.parse(readFileSync(file, "utf8")) as ServiceAccount;

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key);
  const assertion = `${header}.${claims}.${b64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cached.token;
}
