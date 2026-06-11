import { createServer, type Server as HttpServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { globalPaths } from "../config/paths.ts";

// Called when interactive consent is needed, so the host (e.g. the TUI) can show
// the URL in case the browser doesn't open on its own.
export type AuthorizePrompt = (info: { server: string; url: string }) => void;

// Everything we persist between runs for one remote server. Written owner-only
// (0600) since it holds OAuth tokens. `port` is pinned so the loopback redirect
// URI stays stable across runs (and thus matches the registered client).
interface AuthStore {
  port?: number;
  state?: string;
  codeVerifier?: string;
  clientInformation?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
}

const DEFAULT_PORT = 7777;
const CALLBACK_PATH = "/oauth/callback";

function authDir(): string {
  return join(globalPaths().dir, "mcp-auth");
}

// One file per server, keyed by a short hash of its URL.
function storePath(serverUrl: string): string {
  const hash = createHash("sha256").update(serverUrl).digest("hex").slice(0, 16);
  return join(authDir(), `${hash}.json`);
}

// An interactive OAuth 2.1 (PKCE + dynamic client registration) provider that
// persists credentials to disk and catches the redirect on a loopback server.
// One instance per remote server connection.
export class FileOAuthProvider implements OAuthClientProvider {
  private store: AuthStore;
  private readonly path: string;
  private port: number;
  private server?: HttpServer;
  private redirect?: { resolve: (code: string) => void; reject: (e: Error) => void };

  constructor(
    private readonly serverName: string,
    private readonly serverUrl: string,
    private readonly onAuthorize?: AuthorizePrompt,
  ) {
    this.path = storePath(serverUrl);
    this.store = readStore(this.path);
    const envPort = Number(process.env.PRIVATEER_OAUTH_PORT);
    this.port = this.store.port ?? (Number.isInteger(envPort) ? envPort : DEFAULT_PORT);
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}${CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Privateer",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // public client (PKCE), no secret
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.store.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.store.clientInformation = info;
    this.persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.store.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.tokens = tokens;
    this.persist();
  }

  saveCodeVerifier(verifier: string): void {
    this.store.codeVerifier = verifier;
    this.persist();
  }

  codeVerifier(): string {
    if (!this.store.codeVerifier) throw new Error("no PKCE code verifier saved");
    return this.store.codeVerifier;
  }

  state(): string {
    this.store.state = randomBytes(16).toString("hex");
    this.persist();
    return this.store.state;
  }

  // Drop persisted credentials when the server says they're stale, so the next
  // connect re-runs discovery / re-authorizes instead of looping on 401s.
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") this.store = { port: this.store.port };
    else if (scope === "client") delete this.store.clientInformation;
    else if (scope === "tokens") delete this.store.tokens;
    else if (scope === "verifier") delete this.store.codeVerifier;
    this.persist();
  }

  // Bind the loopback listener, open the browser, and arm the wait. The SDK calls
  // this during auth() right before it throws UnauthorizedError.
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.listen();
    this.onAuthorize?.({ server: this.serverName, url: authorizationUrl.toString() });
    openBrowser(authorizationUrl.toString());
  }

  // Resolves with the authorization code once the user is redirected back. Caller
  // passes it to transport.finishAuth(). Always tears the listener down after.
  waitForCode(timeoutMs = 300_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const done = (fn: () => void) => {
        clearTimeout(timer);
        this.closeServer();
        fn();
      };
      const timer = setTimeout(
        () => done(() => reject(new Error(`OAuth for "${this.serverName}" timed out`))),
        timeoutMs,
      );
      this.redirect = {
        resolve: (code) => done(() => resolve(code)),
        reject: (e) => done(() => reject(e)),
      };
    });
  }

  private listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => this.handleCallback(req.url ?? "", res));
      server.once("error", (err) => reject(new Error(`OAuth loopback on port ${this.port}: ${err.message}`)));
      server.listen(this.port, "127.0.0.1", () => {
        this.server = server;
        // Capture the actually-bound port (matters when port 0 = ephemeral) and pin
        // it, so future runs reuse the same redirect URI the client registered with.
        const addr = server.address();
        if (addr && typeof addr === "object") this.port = addr.port;
        this.store.port = this.port;
        this.persist();
        resolve();
      });
    });
  }

  private handleCallback(rawUrl: string, res: import("node:http").ServerResponse): void {
    const url = new URL(rawUrl, this.redirectUrl);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    const state = url.searchParams.get("state");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><body style="font-family:system-ui;padding:2rem">` +
        `<h2>${code ? "Authorized — you can close this tab." : "Authorization failed."}</h2>` +
        `</body>`,
    );
    if (err) return this.redirect?.reject(new Error(`authorization error: ${err}`));
    if (state && this.store.state && state !== this.store.state) {
      return this.redirect?.reject(new Error("OAuth state mismatch (possible CSRF)"));
    }
    if (code) this.redirect?.resolve(code);
    else this.redirect?.reject(new Error("authorization callback missing code"));
  }

  private closeServer(): void {
    this.server?.close();
    this.server = undefined;
  }

  private persist(): void {
    mkdirSync(authDir(), { recursive: true });
    tryChmod(authDir(), 0o700);
    writeFileSync(this.path, JSON.stringify(this.store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    tryChmod(this.path, 0o600);
  }
}

function readStore(path: string): AuthStore {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AuthStore;
  } catch {
    return {};
  }
}

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    /* non-POSIX filesystem — best effort */
  }
}

// Open a URL in the user's default browser. Best-effort and non-blocking; if it
// fails the URL was already surfaced via the AuthorizePrompt callback.
function openBrowser(url: string): void {
  // Headless / CI / tests: skip the launch; the URL is surfaced via AuthorizePrompt.
  if (process.env.PRIVATEER_NO_BROWSER) return;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* headless / no browser — user uses the printed URL */
  }
}

// Wipe stored OAuth state for one server (used by `/mcp logout`).
export function clearStoredAuth(serverUrl: string): void {
  const path = storePath(serverUrl);
  if (existsSync(path)) rmSync(path, { force: true });
}

// Whether we hold an OAuth access token for this server (for `/mcp` status).
export function hasStoredAuth(serverUrl: string): boolean {
  return Boolean(readStore(storePath(serverUrl)).tokens?.access_token);
}
