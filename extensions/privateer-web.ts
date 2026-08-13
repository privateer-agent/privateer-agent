// `web_search` / `web_fetch` for the terminal — one route, chosen at load.
//
// WHAT CHANGED. The TUI used to load @juicesharp/rpiv-web-tools and nothing else, so web
// access at a prompt meant going and getting a provider key first. Being signed in to a
// Privateer account bought you nothing here, even though the same account's unattended
// runs (harbor, channels, ACP) have searched through /api/rag/* all along. Now signing in
// is enough: with no provider of your own configured, the account's search is what the
// tools call — Brave server-side, no key on the machine, the account's daily allowance
// and metering, and the query visible to Privateer's servers (never say a session that
// searches this way is fully private).
//
// PRECEDENCE, AND WHY THIS FILE EXISTS. Both packs register the SAME two tool names, and
// Pi resolves duplicates first-registration-wins — a session holding both would silently
// get whichever loaded first. So exactly one of them may register, and something has to
// decide which: this extension, once per process, via tools/webMode.ts. A configured
// provider always wins. Someone who set up a self-hosted SearXNG picked the more private
// route deliberately, and re-pointing their searches at our servers (billing their account
// for them) would quietly undo that. `PRIVATEER_WEB_SEARCH=privateer` or `"provider":
// "privateer"` in the rpiv config is the way back for someone who holds a key and wants
// the account path anyway.
//
// WHAT IS STILL LIVE, AND WHAT NEEDS A RELAUNCH. `/signin` mid-session works: the account
// tools are registered up front and check for credentials per call, so a signed-out
// terminal says how to fix it rather than silently lacking a web tool. Configuring a
// provider mid-session does NOT switch routes — the registration already happened — so it
// takes effect at the next launch. `/web-tools` is registered either way, so that
// configuration is always reachable.
//
// THE PACK IS OPTIONAL. rpiv-web-tools is a dependency the launcher drops if it didn't
// resolve (a partial or hoisted install). Every import of it here is dynamic and
// failure-tolerant: without it there is no user provider to choose, so the account route
// is the only one left — which is the honest answer, not a fallback.
//
// The specifiers are built rather than written as literals on purpose: it keeps tsc from
// pulling that package's own .ts sources into our typecheck, the same trick config/moat.ts
// uses for pi-mcp-adapter.
import { guardedWebToolDefinitions } from "../src/tools/web.ts";
import { readWebToolsConfig, resolveWebMode, type ProviderMetaLike } from "../src/tools/webMode.ts";

const RPIV_WEB_TOOLS = "@juicesharp/rpiv-web-tools";

// What a signed-out terminal hears when the model reaches for the web. Both exits are
// named because both are real: sign in and it works on the account's allowance, or bring
// a provider of your own and the query never touches our servers.
const SIGNED_OUT_HINT =
  "Web access needs a Privateer account: run /signin to search on your account's " +
  "allowance, or /web-tools to use your own search provider (a Brave/Tavily key, or a " +
  "self-hosted SearXNG) instead.";

interface RpivWebTools {
  registerWebSearchTool(pi: unknown): void;
  registerWebFetchTool(pi: unknown): void;
  registerWebSearchConfigCommand(pi: unknown): void;
  providers: readonly ProviderMetaLike[];
}

async function loadRpivWebTools(): Promise<RpivWebTools | null> {
  try {
    // Two entry points: the package root registers the tools and the `/web-tools`
    // command, and providers/ carries the metadata (which env var holds which provider's
    // key, which providers are self-hosted) that the precedence rules read. Taking that
    // metadata from the package rather than restating it here is what keeps our notion of
    // "configured" from drifting from theirs when it gains a provider.
    const [tools, providers] = await Promise.all([
      import(`${RPIV_WEB_TOOLS}/index.ts`),
      import(`${RPIV_WEB_TOOLS}/providers/index.ts`),
    ]);
    if (typeof tools?.registerWebSearchTool !== "function") return null;
    return {
      registerWebSearchTool: tools.registerWebSearchTool,
      registerWebFetchTool: tools.registerWebFetchTool,
      registerWebSearchConfigCommand: tools.registerWebSearchConfigCommand,
      providers: Array.isArray(providers?.PROVIDERS) ? providers.PROVIDERS : [],
    };
  } catch {
    return null;
  }
}

export default async function privateerWeb(pi: any): Promise<void> {
  const rpiv = await loadRpivWebTools();
  const decision = resolveWebMode({ providers: rpiv?.providers ?? [], config: readWebToolsConfig() });

  if (rpiv && decision.mode === "own") {
    // The user's own provider, run by the package that owns it — its interceptors, its
    // guidance overrides, its truncation. We are choosing between packs, not wrapping one.
    rpiv.registerWebSearchTool(pi);
    rpiv.registerWebFetchTool(pi);
  } else {
    for (const def of guardedWebToolDefinitions(SIGNED_OUT_HINT)) pi.registerTool?.(def);
  }

  // Always available, whichever pack won: it is how a user on the account route configures
  // a provider of their own, and the only place to see which keys are resolving.
  try {
    rpiv?.registerWebSearchConfigCommand(pi);
  } catch {
    /* the command is a convenience — never let it cost the session its web tools */
  }
}
